/**
 * The take-over page: one live frame, the current holder, and the controls that
 * hand control between the user and the agent. It is plain HTML with an
 * inline script on purpose — the page is served by the Host, not by a Client
 * plugin, so it needs no bundle, no locale dictionary, and no build step.
 *
 * @module @deepseek-ai/dsh-headless-browser/page
 */

/** The served document; it contains no placeholders, so every byte is static. */
export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>浏览器接管</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; display: flex; flex-direction: column; height: 100vh; background: #111318; color: #e7e9ee;
    font: 13px/1.5 -apple-system, "PingFang SC", "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: #191c24; border-bottom: 1px solid #2a2f3a; }
  header strong { font-weight: 600; }
  .badge { padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid transparent; }
  .badge.agent { background: #1f2b45; color: #9cc0ff; border-color: #33507f; }
  .badge.human { background: #3a2a12; color: #ffc46b; border-color: #6b4a1f; }
  #reason { flex: 1; color: #98a0b3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button { font: inherit; color: #10131a; background: #d7dded; border: 0; border-radius: 6px; padding: 4px 12px; cursor: pointer; }
  button:hover { background: #eef1f8; }
  #page-url { color: #8ecdf7; max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
    background: #0b0d12; outline: none; overflow: hidden; }
  #frame { max-width: 100%; max-height: 100%; width: auto; height: auto; box-shadow: 0 0 0 1px #2a2f3a; }
  #empty { position: absolute; color: #6f7686; }
  #insert-text { margin-left: auto; width: 24ch; font: inherit; color: inherit; background: #111318;
    border: 1px solid #2a2f3a; border-radius: 6px; padding: 4px 8px; }
</style>
</head>
<body>
<header>
  <strong>浏览器接管</strong>
  <span id="state" class="badge agent">agent 控制中</span>
  <span id="reason">点「取得控制」后可以操作浏览器</span>
  <span id="page-url">浏览器还没打开页面</span>
  <button id="take" hidden>取得控制</button>
  <button id="release" hidden>交还给 agent</button>
  <input id="insert-text" placeholder="输入文本后回车插入" autocomplete="off">
</header>
<main id="stage" tabindex="0">
  <img id="frame" alt="浏览器画面" draggable="false" hidden>
  <div id="empty">等待浏览器…</div>
</main>
<script>
(function () {
  'use strict'
  var VIEW_PATH = '/headless-browser/live'
  var STATUS_PATH = '/headless-browser/status'
  var BUTTONS = ['left', 'middle', 'right']
  var stage = document.getElementById('stage')
  var frame = document.getElementById('frame')
  var empty = document.getElementById('empty')
  var badge = document.getElementById('state')
  var reason = document.getElementById('reason')
  var pageLink = document.getElementById('page-url')
  var takeButton = document.getElementById('take')
  var releaseButton = document.getElementById('release')
  var textInput = document.getElementById('insert-text')
  var holder = 'agent'
  var metadata = null
  var socket = null

  function send(message) {
    if (socket !== null && socket.readyState === 1) socket.send(JSON.stringify(message))
  }

  function setHolder(next, why) {
    holder = next
    var human = next === 'human'
    badge.textContent = human ? '你正在控制' : 'agent 控制中'
    badge.className = 'badge ' + (human ? 'human' : 'agent')
    reason.textContent = human ? (why || '输入会发给浏览器') : '点「取得控制」后可以操作浏览器'
    takeButton.hidden = human
    releaseButton.hidden = !human
  }

  function showFrame(message) {
    metadata = message.metadata
    frame.src = 'data:image/jpeg;base64,' + message.data
    frame.hidden = false
    empty.hidden = true
  }

  function connect() {
    socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + VIEW_PATH)
    socket.onmessage = function (event) {
      var message
      try { message = JSON.parse(event.data) } catch (error) { return }
      if (message.type === 'state') setHolder(message.holder, message.reason)
      else if (message.type === 'frame') showFrame(message)
      else if (message.type === 'error') { empty.hidden = false; empty.textContent = message.message }
    }
    socket.onclose = function () {
      badge.textContent = '连接断开，正在重连'
      window.setTimeout(connect, 1500)
    }
  }

  function pointOf(event) {
    if (metadata === null) return null
    var rect = frame.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: Math.max(0, Math.round((event.clientX - rect.left) * metadata.deviceWidth / rect.width)),
      y: Math.max(0, Math.round((event.clientY - rect.top) * metadata.deviceHeight / rect.height))
    }
  }

  function modifiersOf(event) {
    return (event.altKey ? 1 : 0) + (event.ctrlKey ? 2 : 0) + (event.metaKey ? 4 : 0) + (event.shiftKey ? 8 : 0)
  }

  stage.addEventListener('pointerdown', function (event) {
    if (holder !== 'human') return
    var point = pointOf(event)
    if (point === null) return
    stage.focus()
    send({ type: 'mouse', event: 'down', x: point.x, y: point.y, button: BUTTONS[event.button] || 'none',
      buttons: event.buttons, clickCount: 1, modifiers: modifiersOf(event) })
    event.preventDefault()
  })

  stage.addEventListener('pointerup', function (event) {
    if (holder !== 'human') return
    var point = pointOf(event)
    if (point === null) return
    send({ type: 'mouse', event: 'up', x: point.x, y: point.y, button: BUTTONS[event.button] || 'left',
      buttons: event.buttons, clickCount: 1, modifiers: modifiersOf(event) })
    event.preventDefault()
  })

  stage.addEventListener('pointermove', function (event) {
    if (holder !== 'human' || metadata === null) return
    var point = pointOf(event)
    if (point === null) return
    send({ type: 'mouse', event: 'move', x: point.x, y: point.y, button: 'none',
      buttons: event.buttons, clickCount: 0, modifiers: modifiersOf(event) })
  })

  stage.addEventListener('wheel', function (event) {
    if (holder !== 'human') return
    var point = pointOf(event)
    if (point === null) return
    event.preventDefault()
    send({ type: 'wheel', x: point.x, y: point.y, deltaX: Math.round(event.deltaX),
      deltaY: Math.round(event.deltaY), modifiers: modifiersOf(event) })
  }, { passive: false })

  window.addEventListener('keydown', function (event) {
    if (holder !== 'human') return
    if (event.target === textInput || event.target === takeButton || event.target === releaseButton) return
    var printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
    event.preventDefault()
    send({ type: 'key', event: 'down', key: event.key, code: event.code, keyCode: event.keyCode,
      text: printable ? event.key : undefined, modifiers: modifiersOf(event) })
  })

  window.addEventListener('keyup', function (event) {
    if (holder !== 'human') return
    if (event.target === textInput) return
    event.preventDefault()
    send({ type: 'key', event: 'up', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiersOf(event) })
  })

  textInput.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || textInput.value === '') return
    send({ type: 'text', text: textInput.value })
    textInput.value = ''
    event.stopPropagation()
  })

  stage.addEventListener('paste', function (event) {
    var text = event.clipboardData === null ? '' : event.clipboardData.getData('text')
    if (text === '') return
    send({ type: 'text', text: text })
    event.preventDefault()
  })

  takeButton.addEventListener('click', function () {
    send({ type: 'control', action: 'take', reason: '用户从接管页取得控制' })
  })

  releaseButton.addEventListener('click', function () {
    send({ type: 'control', action: 'release' })
  })

  function refresh() {
    fetch(STATUS_PATH, { cache: 'no-store' }).then(function (response) {
      return response.ok ? response.json() : null
    }).then(function (status) {
      if (status === null) return
      setHolder(status.holder, status.reason)
      if (status.url) {
        pageLink.href = status.url
        pageLink.textContent = status.url
      } else {
        pageLink.removeAttribute('href')
        pageLink.textContent = '浏览器还没打开页面'
      }
    }).catch(function () {
      // The next poll retries; a status request is not worth a visible error.
    })
  }

  connect()
  refresh()
  window.setInterval(refresh, 5000)
})()
</script>
</body>
</html>
`
