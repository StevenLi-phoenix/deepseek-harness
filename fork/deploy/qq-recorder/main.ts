/**
 * qq-recorder service entry point: holds the one connection to NapCat and the recorded QQ data, and answers DSH over a
 * unix socket. Built into a single file (`tsdown.config.ts`) and run by AMS with plain node; it is not a Harness
 * application (no agent, no Cordis tree), so it lives here and not in `apps/`.
 *
 * Environment (AMS declaration): QQ_RECORDER_DATA_DIR, QQ_RECORDER_SOCKET, PORT_health, QQ_RECORDER_BUILD, and the secrets
 * QQ_RECORDER_TOKEN (the bearer token DSH presents) and FORK_QQ_ONEBOT_TOKEN (NapCat's access token, named by DSH's pushed
 * configuration). Logs are JSON lines: info and debug to stdout, error to stderr, which AMS escalates.
 */
import { QqRecorder, type RecorderLogger } from '../../../packages/fork/fork-qq/src/recorder.ts'
import { startRecorderServer, type RecorderServer } from '../../../packages/fork/fork-qq/src/server.ts'

const BUILD = process.env['QQ_RECORDER_BUILD'] ?? 'dev'

function line(level: string, message: string): string {
  return `${JSON.stringify({ level, msg: message, service: 'qq-recorder', ts: new Date().toISOString() })}\n`
}

const logger: RecorderLogger = {
  debug: (message) => { if (process.env['QQ_RECORDER_DEBUG'] === '1') process.stdout.write(line('debug', message)) },
  info: (message) => { process.stdout.write(line('info', message)) },
  error: (message) => { process.stderr.write(line('error', message)) },
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`${name} is not set`)
  return value
}

async function main(): Promise<void> {
  const token = required('QQ_RECORDER_TOKEN')
  const recorder = new QqRecorder({
    dataDir: required('QQ_RECORDER_DATA_DIR'),
    logger,
    secret: name => process.env[name],
    build: BUILD,
  })
  let server: RecorderServer
  try {
    server = await startRecorderServer({
      recorder, logger, token, socketPath: required('QQ_RECORDER_SOCKET'), build: BUILD,
      ...process.env['PORT_health'] === undefined ? {} : { healthPort: Number(process.env['PORT_health']) },
    })
  } catch (error: unknown) {
    await recorder.stop()
    throw error
  }
  recorder.start()
  logger.info(`qq-recorder: started, build ${BUILD}, pid ${process.pid}`)

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    logger.info(`qq-recorder: ${signal}, stopping`)
    void server.close()
      .then(() => recorder.stop())
      .then(() => { process.exit(0) })
      .catch((error: unknown) => {
        logger.error(`qq-recorder: stopping failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      })
  }
  process.on('SIGTERM', () => { stop('SIGTERM') })
  process.on('SIGINT', () => { stop('SIGINT') })
}

main().catch((error: unknown) => {
  logger.error(`qq-recorder: could not start: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
