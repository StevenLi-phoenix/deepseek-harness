/**
 * Hand each batch to its actuator: a note to `ctx.ownerNotifier`, a new Session through `ctx.webhookRuntime`, or a
 * persistent subscription's Session; and rebuild a new Session's request when the bus's webhook rule runs.
 */

import type { VerifiedWebhookDelivery, WebhookDeliveryId, WebhookSessionRequest, WebhookSourceId } from '@deepseek-ai/dsh-webhook'
import { z as zod } from 'zod'
import { BUS_EVENT_KIND, type ProjectDirectories } from './delivery.ts'
import type { HostServices } from './host.ts'
import { errorText, type BusLogger } from './log.ts'
import { buildSessionRequest, formatBatchNote, type CarriedOver } from './prompt.ts'
import type { EventQueue, FlushedBatch } from './queue.ts'
import type { RouteSet } from './routes.ts'
import type { SessionAction, SessionDelivery } from './types.ts'

/** Shape check for deliveries that come back through the webhook rule. */
const deliveryEventSchema = zod.object({
  subscription: zod.string(),
  events: zod.array(zod.object({
    id: zod.string(),
    source: zod.string(),
    kind: zod.string(),
    subject: zod.string(),
    title: zod.string(),
    url: zod.string().optional(),
    actor: zod.string().optional(),
    text: zod.string().optional(),
    occurredAt: zod.number().optional(),
  })),
})

/** A `session` batch handed to the webhook runtime or a persistent Session, until its turn's first user message arrives. */
export interface PendingDelivery {
  delivery: SessionDelivery
  carried?: CarriedOver
  /** The persistent Session key's subject (`key: subject`). */
  subject?: string
  /** Fixed title of a persistent Session. */
  title?: string
}

/** What the dispatcher reads and calls. */
export interface BatchDispatcherDeps {
  host: Pick<HostServices, 'notifier' | 'webhookRuntime'>
  routes: Pick<RouteSet, 'byId'>
  projects: Pick<ProjectDirectories, 'ensure'>
  batches: Pick<EventQueue, 'markBatch'>
  /** Deliver a batch of a subscription with `session.persistent.enabled`. */
  deliverPersistent(flushed: FlushedBatch, session: SessionAction): Promise<void>
  /** Events listed in one notify message. */
  maxNoteEvents: number
  logger: BusLogger
}

/** Holds each dispatched `session` batch's {@link PendingDelivery} in memory until its Session's first message takes it. */
export class BatchDispatcher {
  private readonly deliveries = new Map<string, PendingDelivery>()

  /** @param deps - Host services, routes, project directories, and batch records. */
  constructor(private readonly deps: BatchDispatcherDeps) {}

  /**
   * Hand one batch to its actuator and record the result.
   * @param flushed - the persisted batch.
   * @returns resolves once the actuator took the batch or its failure is recorded.
   */
  async actuate(flushed: FlushedBatch): Promise<void> {
    const { batch, events, subscription } = flushed
    const { batches } = this.deps
    if (subscription.action === 'notify') {
      const notifier = this.deps.host.notifier()
      if (notifier === undefined) {
        await batches.markBatch(batch.id, { status: 'failed', error: 'no ownerNotifier service is mounted' })
        return
      }
      try {
        await notifier.send(formatBatchNote(subscription.id, events, this.deps.maxNoteEvents))
        await batches.markBatch(batch.id, { status: 'delivered' })
      } catch (error: unknown) {
        this.deps.logger.warn(`event-bus: notify ${batch.id} failed: ${errorText(error)}`)
        await batches.markBatch(batch.id, { status: 'failed', error: errorText(error) })
      }
      return
    }

    const session = subscription.session
    if (session?.persistent?.enabled === true) {
      await this.deps.deliverPersistent(flushed, session)
      return
    }
    await this.start(flushed, 'fresh')
  }

  /**
   * Start a new Session for one batch through the webhook runtime.
   * @param flushed - the batch.
   * @param delivery - how the batch is delivered, recorded on the batch.
   * @param extra - what the webhook rule and the first message need besides `delivery`.
   * @returns resolves once the runtime took the delivery or its failure is recorded.
   */
  async start(flushed: FlushedBatch, delivery: SessionDelivery, extra: Omit<PendingDelivery, 'delivery'> = {}): Promise<void> {
    const { batch, events, subscription } = flushed
    const { batches } = this.deps
    const runtime = this.deps.host.webhookRuntime()
    if (runtime === undefined) {
      await batches.markBatch(batch.id, { status: 'failed', error: 'no webhookRuntime service is mounted', delivery })
      return
    }
    const project = subscription.session?.project
    if (project !== undefined && project !== '' && subscription.session !== undefined) await this.deps.projects.ensure(subscription.session.workspacePath, project)
    this.deliveries.set(batch.id, { delivery, ...extra })
    try {
      runtime.dispatch({
        kind: BUS_EVENT_KIND,
        source: subscription.id as WebhookSourceId,
        deliveryId: batch.id as WebhookDeliveryId,
        event: { subscription: subscription.id, events },
        receivedAt: batch.createdAt,
      })
      await batches.markBatch(batch.id, { delivery })
    } catch (error: unknown) {
      this.deliveries.delete(batch.id)
      this.deps.logger.warn(`event-bus: session dispatch ${batch.id} failed: ${errorText(error)}`)
      await batches.markBatch(batch.id, { status: 'failed', error: errorText(error), delivery })
    }
  }

  /**
   * Remember how a batch reaches a Session that already exists, until its turn's first message arrives.
   * @param batchId - the batch, which is the message's delivery id.
   * @param pending - how it is delivered.
   */
  expect(batchId: string, pending: PendingDelivery): void {
    this.deliveries.set(batchId, pending)
  }

  /**
   * Forget a batch that did not reach its Session.
   * @param batchId - the batch.
   */
  forget(batchId: string): void {
    this.deliveries.delete(batchId)
  }

  /**
   * Take a batch's pending delivery when its Session's first message arrives.
   * @param batchId - the batch.
   * @returns the pending delivery, or undefined after a restart or for a batch this process did not dispatch.
   */
  take(batchId: string): PendingDelivery | undefined {
    const pending = this.deliveries.get(batchId)
    this.deliveries.delete(batchId)
    return pending
  }

  /**
   * Webhook rule body: rebuild the Session request from the subscription that produced the delivery.
   * @param delivery - the verified delivery.
   * @returns the request, or null when its subscription is gone, is not a `session` route, or the event is malformed.
   */
  sessionRequest(delivery: Readonly<VerifiedWebhookDelivery<typeof BUS_EVENT_KIND>>): WebhookSessionRequest | null {
    const subscription = this.deps.routes.byId(delivery.source)
    if (subscription?.action !== 'session' || subscription.session === undefined) return null
    const parsed = deliveryEventSchema.safeParse(delivery.event)
    if (!parsed.success) {
      this.deps.logger.warn(`event-bus: delivery ${delivery.deliveryId} carries a malformed event`)
      return null
    }
    const pending = this.deliveries.get(delivery.deliveryId)
    const request = buildSessionRequest(subscription.id, subscription.session, parsed.data.events, pending?.carried)
    return pending?.title === undefined ? request : { ...request, title: pending.title }
  }
}
