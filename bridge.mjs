import { spawn } from "child_process"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "fs"
import { homedir } from "os"
import { basename, dirname, extname, join, resolve } from "path"

const STATE_DIR = join(homedir(), ".claude", "channels", "telegram")
const ENV_FILE = join(STATE_DIR, ".env")
const STATE_FILE = join(STATE_DIR, "bridge-state.json")
const QUEUE_FILE = join(STATE_DIR, "bridge-queue.json")
const WORKDIR = "C:\\Projects"
const CLAUDE = join(homedir(), ".local", "bin", "claude.exe")
const MODELS = {
  opus: { id: "opus", label: "Opus 5.5" },
  sonnet: { id: "sonnet", label: "Sonnet 5.5" },
  fable: { id: "fable", label: "Fable 5.1" },
}
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]
const OWNER_ID = "8722477012"

function loadToken() {
  const text = readFileSync(ENV_FILE, "utf8")
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith("TELEGRAM_BOT_TOKEN=")) return line.slice("TELEGRAM_BOT_TOKEN=".length).trim()
  }
  throw new Error("TELEGRAM_BOT_TOKEN missing")
}

const TOKEN = loadToken()
const API = `https://api.telegram.org/bot${TOKEN}`

function blankChat() {
  return {
    sessionId: null,
    workdir: null,
    model: null,
    effort: null,
  }
}

function loadState() {
  let state
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8"))
  } catch {
    state = { allowFrom: [], offset: 0 }
  }
  if (!state.chats) {
    state.chats = {
      main: {
        sessionId: state.sessionId || null,
        workdir: state.workdir || null,
        model: state.model || null,
        effort: state.effort || null,
      },
    }
    delete state.sessionId
    delete state.workdir
    delete state.model
    delete state.effort
  }
  if (state.chats.main && state.allowFrom?.[0]) {
    const privateId = String(state.allowFrom[0])
    if (!state.chats[privateId]) {
      state.chats[privateId] = { ...state.chats.main, title: "private chat", type: "private" }
    }
    delete state.chats.main
  }
  delete state.active
  state.allowFrom = [OWNER_ID]
  return state
}

function chatKey(chatId, threadId) {
  return threadId ? `${chatId}:${threadId}` : String(chatId)
}

function topicTitle(message) {
  const name = message?.forum_topic_created?.name
    || message?.reply_to_message?.forum_topic_created?.name
    || message?.forum_topic_edited?.name
  return name ? String(name).slice(0, 80) : ""
}

function chatLabel(chat, key) {
  const group = chat.title || (chat.type === "private" ? "private chat" : key)
  if (chat.threadId) return `${group} / ${chat.topicTitle || "topic " + chat.threadId}`
  if (chat.isForum) return `${group} / General`
  return group
}

function ensureChat(state, chatInfo, threadId, topicName) {
  const key = chatKey(chatInfo.id, threadId)
  if (!state.chats[key]) state.chats[key] = blankChat()
  const chat = state.chats[key]
  chat.title = chatInfo.title || (chatInfo.type === "private" ? "private chat" : chat.title || key)
  chat.type = chatInfo.type || chat.type
  if (chatInfo.is_forum) chat.isForum = true
  if (threadId) chat.threadId = threadId
  if (topicName) chat.topicTitle = topicName
  return chat
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`${method} failed: ${data.description || res.status}`)
  return data.result
}

function modelHelp(current) {
  const lines = ["Current model: " + (current || "opus (default)")]
  lines.push("")
  lines.push("Choose one:")
  for (const [name, model] of Object.entries(MODELS)) {
    lines.push(`/model ${name} — ${model.label}`)
  }
  lines.push("/model default — back to Opus")
  return lines.join("\n")
}

function effortHelp(current) {
  const lines = ["Current effort: " + (current || "high (default)")]
  lines.push("")
  lines.push("Choose one:")
  for (const level of EFFORTS) lines.push(`/effort ${level}`)
  lines.push("/effort default — back to high")
  return lines.join("\n")
}

function currentFolder(chat) {
  return chat.workdir || WORKDIR
}

function childFolders(dir) {
  const skip = new Set(["node_modules", ".git", ".venv", "venv", "dist"])
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !skip.has(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  } catch {
    return []
  }
}

function readHead(file, max = 80000) {
  const fd = openSync(file, "r")
  try {
    const buf = Buffer.alloc(max)
    const n = readSync(fd, buf, 0, max, 0)
    return buf.subarray(0, n).toString("utf8")
  } finally {
    closeSync(fd)
  }
}

function sessionPreview(text) {
  return String(text || "")
    .replace(/^Follow this caption:\s*/i, "")
    .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90)
}

function listComputerSessions(state) {
  const root = join(homedir(), ".claude", "projects")
  const titles = new Map()
  for (const chat of Object.values(state?.chats || {})) {
    if (chat?.sessionId && !titles.has(chat.sessionId)) titles.set(chat.sessionId, chatLabel(chat, ""))
  }
  const files = []
  let dirs = []
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    dirs = []
  }
  for (const dir of dirs) {
    let entries = []
    try {
      entries = readdirSync(join(root, dir.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const id = entry.name.slice(0, -".jsonl".length)
      if (!/^[0-9a-f-]{36}$/i.test(id)) continue
      const path = join(root, dir.name, entry.name)
      try {
        files.push({ id, path, ts: statSync(path).mtimeMs })
      } catch {
        continue
      }
    }
  }
  files.sort((a, b) => b.ts - a.ts)
  const sessions = []
  for (const file of files) {
    if (sessions.length >= 12) break
    const head = readHead(file.path)
    const lines = head.split(/\n/)
    if (head.length >= 79000) lines.pop()
    let project = ""
    let preview = ""
    let sidechain = false
    for (const line of lines) {
      if (!line.trim()) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row.type === "user" && row.isSidechain) {
        sidechain = true
        break
      }
      if (!project && row.attachment?.type === "environment") project = row.attachment.snapshot?.workingDirectory || ""
      if (!preview && row.type === "queue-operation" && row.operation === "enqueue" && row.content) preview = sessionPreview(row.content)
      if (!preview && row.type === "user") {
        const content = row.message?.content
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join(" ") : ""
        if (text.trim()) preview = sessionPreview(text)
      }
    }
    if (sidechain) continue
    const title = titles.get(file.id)
    if (title) preview = preview ? `${title} — ${preview}` : title
    sessions.push({ id: file.id, project, ts: file.ts, preview })
  }
  return sessions
}

function formatWhen(ts) {
  if (!ts) return ""
  return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

function describeChat(chat, key) {
  const model = MODELS[chat.model]?.label || (chat.model ? chat.model : "Opus 5.5")
  const effort = chat.effort || "high"
  const speed = chat.speed === "off" ? "Standard" : "Fast"
  const folder = chat.workdir || "No folder chosen yet"
  return `${chatLabel(chat, key)}\n${folder}\n${model} · ${effort} · ${speed}`
}

function parseCommand(text) {
  const match = text.match(/^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  return { name: match[1].toLowerCase(), arg: (match[2] || "").trim() }
}

function taskPreview(job) {
  const text = String(job?.text || "").replace(/\s+/g, " ").trim()
  const names = (job?.files || []).map((file) => file.name).filter(Boolean)
  const parts = []
  if (text) parts.push(text.slice(0, 160))
  if (names.length) parts.push(names.slice(0, 3).join(", "))
  return parts.join("\n")
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins <= 0) return `${secs}s`
  return `${mins}m ${secs}s`
}

function activityText(job) {
  const lines = []
  if (job.title) lines.push(`Working in ${job.title}.`)
  const task = taskPreview(job)
  if (task) lines.push(task)
  lines.push(formatElapsed(Date.now() - (job.startedAt || Date.now())))
  const steps = job.steps || []
  if (!steps.length) {
    lines.push("Now: starting.")
  } else {
    lines.push(`Now: ${steps[steps.length - 1]}`)
    const recent = steps.slice(0, -1).slice(-5)
    if (recent.length) {
      lines.push("Recent:")
      for (const step of recent) lines.push(`• ${step}`)
    }
  }
  return lines.join("\n").slice(0, 1500)
}

function humanTool(name) {
  return String(name || "Working").split("__").pop().replace(/_/g, " ")
}

function stepFromTool(name, input) {
  const fields = input && typeof input === "object" ? input : {}
  const description = String(fields.description || "").replace(/\s+/g, " ").trim()
  if (description) return description.slice(0, 90)
  const file = basename(String(fields.file_path || fields.path || fields.notebook_path || ""))
  const tool = humanTool(name)
  if (/^(powershell|bash|shell)$/i.test(tool) && !file) return "Running a command"
  if (/^read$/i.test(tool) && file) return `Reading ${file}`
  if (/^(edit|write)$/i.test(tool) && file) return `Editing ${file}`
  if (file) return `${tool} ${file}`.slice(0, 120)
  return tool.slice(0, 120)
}

function shortNote(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim()
  if (!clean || clean.length < 8) return ""
  const sentence = clean.split(/(?<=[.!?])\s/)[0]
  return sentence.slice(0, 180)
}

function stepsFromEvent(obj) {
  if (!obj || typeof obj !== "object") return []
  if (obj.type && obj.type !== "assistant") return []
  const content = obj.message?.content
  if (!Array.isArray(content)) return []
  const steps = []
  for (const part of content) {
    if (part?.type === "tool_use") steps.push(stepFromTool(part.name, part.input))
    else if (part?.type === "text") {
      const note = shortNote(part.text)
      if (note) steps.push(note)
    }
  }
  return steps.filter(Boolean)
}

function runClaude(prompt, sessionId, model, effort, speed, workdir, onProgress) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "auto",
    "--append-system-prompt",
    "You are being used from Telegram. Keep replies concise enough to read on a phone. Work in the current working directory. When a message lists attached files, follow the caption and read every file, including PDFs and documents. Read images, and transcribe or listen to audio and video before answering. When the prompt includes an earlier message the user is replying to, that earlier message is what they mean. To send a photo, video, audio, or other file back, put one line in the reply for each file, using the full path: SEND_FILE: C:\\\\path\\\\file.ext | short caption. The bridge delivers that file to this same chat and topic. Do not call the Telegram Bot API, curl, or tg_send_file.py.",
  ]
  args.push("--model", model || "opus")
  args.push("--effort", effort || "high")
  const opus = !model || model === "opus"
  args.push("--settings", JSON.stringify({ fastMode: speed !== "off" && opus }))
  if (sessionId) args.push("--resume", sessionId)
  args.push(prompt)
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { cwd: workdir || WORKDIR, windowsHide: true })
    let stdout = ""
    let stderr = ""
    let buffer = ""
    child.stdout.on("data", (chunk) => {
      const piece = chunk.toString()
      stdout += piece
      if (!onProgress) return
      buffer += piece
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ""
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          for (const step of stepsFromEvent(JSON.parse(line))) onProgress(step)
        } catch {}
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `claude exited ${code}`))
        return
      }
      resolve(stdout)
    })
  })
}

function parseClaude(stdout) {
  const tail = stdout.length > 400000 ? stdout.slice(-400000) : stdout
  const lines = tail.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i])
      if (obj.type === "result" && typeof obj.result === "string") return obj
    } catch {}
  }
  return { result: "The run stopped before it could reply. Send another message in this chat to continue." }
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function markdownToTelegramHtml(src) {
  const blocks = []
  const hold = (html) => {
    const token = `\uE000${blocks.length}\uE001`
    blocks.push(html)
    return token
  }
  let text = src.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const language = String(lang || "").trim().replace(/[^a-z0-9_+-]/gi, "")
    const cls = language ? ` class="language-${language}"` : ""
    return hold(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`)
  })
  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`))
  text = escapeHtml(text)
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url.replace(/"/g, "%22")}">${label}</a>`)
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
  text = text.replace(/__([^_\n]+)__/g, "<b>$1</b>")
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
  text = text.replace(/(^|[\s([{])\*([^*\n]+)\*(?=$|[\s)\].,!?:;])/gm, "$1<i>$2</i>")
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
  text = text.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>")
  text = text.replace(/<\/blockquote>\n<blockquote>/g, "\n")
  text = text.replace(/^[-*]\s+/gm, "• ")
  return text.replace(/\uE000(\d+)\uE001/g, (_, index) => blocks[Number(index)])
}

function splitMessage(text, limit = 3200) {
  if (text.length <= limit) return [text]
  const parts = []
  let buf = ""
  const flush = () => {
    if (buf) parts.push(buf)
    buf = ""
  }
  for (const para of text.split(/\n{2,}/)) {
    const next = buf ? `${buf}\n\n${para}` : para
    if (next.length <= limit) {
      buf = next
      continue
    }
    flush()
    if (para.length <= limit) {
      buf = para
      continue
    }
    for (const line of para.split("\n")) {
      if (line.length > limit) {
        flush()
        for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit))
        continue
      }
      const joined = buf ? `${buf}\n${line}` : line
      if (joined.length > limit) {
        flush()
        buf = line
      } else buf = joined
    }
  }
  flush()
  return parts.length ? parts : [text]
}

function topicId(message) {
  if (!message?.is_topic_message) return undefined
  const id = Number(message?.message_thread_id)
  return Number.isInteger(id) && id > 0 ? id : undefined
}

function noteForumTopic(state, message) {
  const created = message?.forum_topic_created?.name
  const edited = message?.forum_topic_edited?.name
  const name = created || edited
  if (!name || !message?.chat?.id) return
  const threadId = topicId(message) || Number(message.message_thread_id) || (created ? Number(message.message_id) : 0)
  if (!Number.isInteger(threadId) || threadId <= 0) return
  const chat = ensureChat(state, message.chat, threadId, String(name).slice(0, 80))
  chat.topicLookupFailed = false
  saveState(state)
}

async function learnTopicName(state, chat, chatId) {
  if (!chat.threadId || chat.topicTitle || chat.topicLookupFailed) return
  let name = ""
  try {
    const topic = await tg("getForumTopic", { chat_id: chatId, message_thread_id: chat.threadId })
    name = topic?.name || ""
  } catch (err) {
    console.error("topic name lookup failed", err.message || err)
  }
  if (!name) {
    try {
      const forwarded = await tg("forwardMessage", {
        chat_id: OWNER_ID,
        from_chat_id: chatId,
        message_id: chat.threadId,
        disable_notification: true,
      })
      name = forwarded?.forum_topic_created?.name || ""
      if (forwarded?.message_id) await tg("deleteMessage", { chat_id: OWNER_ID, message_id: forwarded.message_id }).catch(() => {})
    } catch (err) {
      console.error("topic name forward failed", err.message || err)
    }
  }
  if (name) {
    chat.topicTitle = String(name).slice(0, 80)
    saveState(state)
    return
  }
  chat.topicLookupFailed = true
  saveState(state)
}

function quoted(chatId, messageId, fields, threadId) {
  const body = { chat_id: chatId, ...fields }
  if (threadId) body.message_thread_id = threadId
  if (messageId) body.reply_parameters = { message_id: messageId, allow_sending_without_reply: true }
  return body
}

async function sendChunks(chatId, text, replyToId, threadId) {
  const body = text.trim() || "(no reply)"
  for (const chunk of splitMessage(body)) {
    const html = markdownToTelegramHtml(chunk)
    if (html.length <= 4000) {
      try {
        await tg("sendMessage", quoted(chatId, replyToId, { text: html, parse_mode: "HTML" }, threadId))
        continue
      } catch (err) {
        if (!/parse|entit/i.test(String(err.message || err))) throw err
        console.error("markdown send failed", err.message || err)
      }
    }
    await tg("sendMessage", quoted(chatId, replyToId, { text: chunk.slice(0, 4000) }, threadId))
  }
}

function takeOutboundFiles(text) {
  const files = []
  const kept = []
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*SEND_FILE:\s*(.+?)\s*$/i)
    if (!match) {
      kept.push(line)
      continue
    }
    const parts = match[1].split(/\s+\|\s+/)
    const filePath = parts[0].trim().replace(/^["']|["']$/g, "")
    const caption = parts.slice(1).join(" | ").trim()
    if (filePath) files.push({ filePath, caption })
  }
  return { text: kept.join("\n").trim(), files }
}

function mediaKind(filePath) {
  const ext = extname(filePath).slice(1).toLowerCase()
  if (["jpg", "jpeg", "png", "webp"].includes(ext)) return { method: "sendPhoto", field: "photo" }
  if (ext === "mp4") return { method: "sendVideo", field: "video" }
  if (["ogg", "opus"].includes(ext)) return { method: "sendVoice", field: "voice" }
  if (["mp3", "m4a", "wav"].includes(ext)) return { method: "sendAudio", field: "audio" }
  return { method: "sendDocument", field: "document" }
}

async function sendOutboundFile(chatId, threadId, replyToId, file) {
  const filePath = resolve(file.filePath)
  if (filePath.toLowerCase() === resolve(ENV_FILE).toLowerCase()) throw new Error("That file is not sent.")
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    await tg("sendMessage", quoted(chatId, replyToId, { text: `Could not find that file:\n${file.filePath}` }, threadId))
    return
  }
  if (statSync(filePath).size > 50 * 1024 * 1024) {
    await tg("sendMessage", quoted(chatId, replyToId, { text: `That file is over 50 MB, which is the largest Telegram lets this bot upload:\n${filePath}` }, threadId))
    return
  }
  const kind = mediaKind(filePath)
  const form = new FormData()
  form.append("chat_id", String(chatId))
  if (threadId) form.append("message_thread_id", String(threadId))
  if (replyToId) form.append("reply_parameters", JSON.stringify({ message_id: replyToId, allow_sending_without_reply: true }))
  if (file.caption) form.append("caption", file.caption.slice(0, 1024))
  form.append(kind.field, new Blob([readFileSync(filePath)]), basename(filePath))
  const res = await fetch(`${API}/${kind.method}`, { method: "POST", body: form })
  const data = await res.json()
  if (!data.ok) throw new Error(`${kind.method} failed: ${data.description || res.status}`)
}

function groupWelcome(title) {
  return `${title} is its own Claude Code conversation. Choose a folder before the first message.\n\nThe buttons pick the folder, model, effort, speed, a new chat, and status. You can send text, photos, voice notes, video, and files.`
}

function queueMarkup(jobId) {
  return {
    inline_keyboard: [[
      { text: "Run next", callback_data: `q:next:${jobId}` },
      { text: "Drop", callback_data: `q:drop:${jobId}` },
    ]],
  }
}

function actionsMarkup() {
  return {
    keyboard: [
      [{ text: "Folder" }, { text: "Model" }, { text: "Effort" }],
      [{ text: "Speed" }, { text: "New chat" }, { text: "Status" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  }
}

function modelMarkup(current) {
  return {
    inline_keyboard: Object.entries(MODELS).map(([id, model]) => [{
      text: current === id || (!current && id === "opus") ? `${model.label} ✓` : model.label,
      callback_data: `m:${id}`,
    }]),
  }
}

function speedMarkup(current) {
  const fast = current !== "off"
  return {
    inline_keyboard: [
      [{ text: fast ? "Fast ✓" : "Fast", callback_data: "s:fast" }],
      [{ text: fast ? "Standard" : "Standard ✓", callback_data: "s:off" }],
    ],
  }
}

function effortMarkup(current) {
  return {
    inline_keyboard: EFFORTS.map((level) => [{
      text: current === level || (!current && level === "high") ? `${level} ✓` : level,
      callback_data: `e:${level}`,
    }]),
  }
}

async function showFolders(state, chat, chatId, editMessageId, threadId) {
  const here = existsSync(chat.browse || "") ? chat.browse : (chat.workdir || WORKDIR)
  chat.browse = here
  const parent = dirname(here)
  const kids = childFolders(here)
  const pageSize = 8
  const pages = Math.max(1, Math.ceil(kids.length / pageSize))
  const page = Math.min(Math.max(0, chat.folderPage || 0), pages - 1)
  chat.folderPage = page
  chat.folderList = []
  const rows = []
  if (parent && parent !== here) {
    chat.folderList.push(parent)
    rows.push([{ text: "..", callback_data: "f:0" }])
  }
  for (const name of kids.slice(page * pageSize, (page + 1) * pageSize)) {
    const index = chat.folderList.length
    chat.folderList.push(join(here, name))
    rows.push([{ text: name.slice(0, 40), callback_data: `f:${index}` }])
  }
  const nav = []
  if (page > 0) nav.push({ text: "Prev", callback_data: `f:page:${page - 1}` })
  if (page < pages - 1) nav.push({ text: "Next", callback_data: `f:page:${page + 1}` })
  if (nav.length) rows.push(nav)
  rows.push([
    { text: "New folder", callback_data: "f:new" },
    { text: "Use this folder", callback_data: "f:use" },
  ])
  saveState(state)
  const text = `Open a folder, create one, or tap Use this folder.\n\n${here}`
  const reply_markup = { inline_keyboard: rows }
  if (editMessageId) {
    try {
      await tg("editMessageText", { chat_id: chatId, message_id: editMessageId, text, reply_markup })
      return
    } catch (err) {
      if (/not modified/i.test(String(err.message || err))) return
    }
  }
  await tg("sendMessage", quoted(chatId, undefined, { text, reply_markup }, threadId))
}

function folderNameFrom(raw) {
  const original = String(raw || "").trim()
  if (!original || /[\\/<>:"|?*\u0000-\u001f]/.test(original)) return ""
  const cleaned = original.replace(/[. ]+$/g, "").slice(0, 80)
  if (!cleaned || cleaned === "." || cleaned === "..") return ""
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) return ""
  return cleaned
}

async function createNamedFolder(state, chat, chatId, rawName, replyToId, threadId) {
  const parent = chat.pendingFolderParent || chat.browse || chat.workdir || WORKDIR
  const name = folderNameFrom(rawName)
  if (!name) {
    chat.awaitingFolderName = true
    saveState(state)
    await tg("sendMessage", quoted(chatId, replyToId, { text: "Send a plain folder name, with no slashes. Tap Folder to cancel." }, threadId))
    return
  }
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    chat.awaitingFolderName = false
    saveState(state)
    await tg("sendMessage", quoted(chatId, replyToId, { text: "That location is no longer on this computer. Tap Folder and choose again." }, threadId))
    return
  }
  const folderPath = join(parent, name)
  let created = false
  if (!existsSync(folderPath)) {
    mkdirSync(folderPath)
    created = true
  } else if (!statSync(folderPath).isDirectory()) {
    chat.awaitingFolderName = true
    saveState(state)
    await tg("sendMessage", quoted(chatId, replyToId, { text: "A file with that name is already there. Send a different name." }, threadId))
    return
  }
  chat.awaitingFolderName = false
  chat.browse = folderPath
  chat.folderPage = 0
  saveState(state)
  await tg("sendMessage", quoted(chatId, replyToId, {
    text: created ? `Created ${name}.\n${folderPath}` : `${name} already exists.\n${folderPath}`,
  }, threadId))
  await showFolders(state, chat, chatId, undefined, threadId)
}

async function beginChat(state, chat, chatId, threadId) {
  await tg("sendMessage", quoted(chatId, undefined, {
    text: groupWelcome(chatLabel(chat, String(chatId))),
    reply_markup: actionsMarkup(),
  }, threadId))
  if (!chat.workdir) {
    chat.browse = WORKDIR
    chat.folderPage = 0
    await showFolders(state, chat, chatId, undefined, threadId)
  }
}

function safeFileName(name) {
  const base = basename(String(name || "")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim()
  return base.slice(0, 80)
}

function numberPhotos(files) {
  let photo = 0
  return files.map((file) => {
    if (file.kind !== "photo") return file
    photo += 1
    return { ...file, name: `photo-${photo}.jpg` }
  })
}

function readTextAttachment(filePath, name) {
  const ext = extname(String(name || filePath || "")).toLowerCase()
  if (![".txt", ".md", ".text"].includes(ext)) return ""
  try {
    const buf = readFileSync(filePath)
    if (!buf.length || buf.length > 400000 || buf.includes(0)) return ""
    return buf.toString("utf8").slice(0, 100000)
  } catch {
    return ""
  }
}

function attachments(message) {
  const items = []
  const add = (fileId, kind, name) => {
    if (fileId) items.push({ fileId, kind, name: safeFileName(name) })
  }
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = message.photo.reduce((best, photo) => ((photo.file_size || 0) >= (best.file_size || 0) ? photo : best))
    add(largest.file_id, "photo", "photo.jpg")
  }
  add(message.voice?.file_id, "voice note", message.voice?.file_name || "voice.ogg")
  add(message.audio?.file_id, "audio", message.audio?.file_name)
  add(message.video?.file_id, "video", message.video?.file_name)
  add(message.video_note?.file_id, "video note", "video-note.mp4")
  add(message.document?.file_id, "file", message.document?.file_name)
  add(message.animation?.file_id, "animation", message.animation?.file_name)
  return items
}

async function downloadTelegram(fileId, destDir, name) {
  const info = await tg("getFile", { file_id: fileId })
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`)
  if (!res.ok) throw new Error(`download failed (${res.status})`)
  mkdirSync(destDir, { recursive: true })
  const leaf = safeFileName(name) || basename(info.file_path)
  const dest = join(destDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${leaf}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}

function describeReply(message) {
  const quoted = message?.reply_to_message
  const selected = String(message?.quote?.text || "").replace(/\s+$/g, "").trim()
  if (quoted && !quoted.forum_topic_created && !quoted.forum_topic_edited && !quoted.forum_topic_closed && !quoted.forum_topic_reopened) {
    const body = String(quoted.text || quoted.caption || "").trim()
    const files = attachments(quoted)
    if (selected || body || files.length) {
      const lines = [quoted.from?.is_bot
        ? "The user is replying to your previous message. That message is what they are referring to:"
        : "The user is replying to this earlier message. That message is what they are referring to:"]
      if (selected) lines.push(`Selected part:\n${selected.slice(0, 2000)}`)
      if (body) lines.push(body.slice(0, 4000))
      else if (files.length) lines.push(`(${files.map((file) => file.kind).join(", ")} with no caption)`)
      return { text: lines.join("\n"), files }
    }
  }
  const external = message?.external_reply
  if (!external && !selected) return null
  if (!external) return null
  const where = external.chat?.title || "another chat"
  const kind = external.document ? "file" : external.photo ? "photo" : external.video ? "video" : external.voice ? "voice note" : external.audio ? "audio" : ""
  const lines = [`The user is replying to a message in ${where}.`]
  if (kind) lines.push(`That message is a ${kind}.`)
  if (selected) lines.push(`Selected part:\n${selected.slice(0, 2000)}`)
  return { text: lines.join("\n"), files: [] }
}

function attachmentPrompt(text, saved, quote) {
  const lines = []
  if (quote?.text) {
    lines.push(quote.text)
    lines.push("")
  }
  if (text) {
    lines.push(quote?.text ? "Their reply:" : "Follow this caption:")
    lines.push(text)
  }
  if (quote?.saved?.length) {
    if (lines.length) lines.push("")
    lines.push("Files on the message they replied to:")
    for (const item of quote.saved) {
      const name = item.name ? ` "${item.name}"` : ""
      lines.push(item.path ? `- ${item.kind}${name}: ${item.path}` : `- ${item.kind}${name}: ${item.note}`)
    }
  }
  if (saved.length) {
    if (lines.length) lines.push("")
    lines.push("Read each attached file before answering:")
    for (const item of saved) {
      const name = item.name ? ` "${item.name}"` : ""
      lines.push(`- ${item.kind}${name}: ${item.path}`)
    }
  }
  return lines.join("\n").trim()
}

function isControlMessage(message) {
  const text = (message.text || message.caption || "").trim()
  if (parseCommand(text)?.name === "ignore") return true
  if (!text || attachments(message).length) return false
  if (parseCommand(text)) return true
  return ["folder", "model", "effort", "speed", "new chat", "status"].includes(text.toLowerCase())
}

function takeReady(pending) {
  const callbackIndex = pending.findIndex((item) => item.callback)
  if (callbackIndex !== -1) return pending.splice(callbackIndex, 1)[0]
  if (!pending.length) return null
  const first = pending[0]
  if (first.join || !first.message) return pending.shift()

  const groupId = first.message.media_group_id
  if (isControlMessage(first.message) && !groupId) return { messages: [pending.shift().message] }

  const chatId = first.message.chat?.id
  const thread = topicId(first.message)
  const groupIds = new Set()
  if (groupId) groupIds.add(groupId)
  const indexes = [0]
  for (let i = 1; i < pending.length; i++) {
    const item = pending[i]
    if (!item.message || item.message.chat?.id !== chatId || topicId(item.message) !== thread) break
    if (isControlMessage(item.message) && !item.message.media_group_id) break
    const gid = item.message.media_group_id
    if (gid && groupIds.size && !groupIds.has(gid)) break
    if (gid) groupIds.add(gid)
    indexes.push(i)
  }
  if (groupIds.size) {
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i]
      if (indexes.includes(i) || !item.message) continue
      if (item.message.chat?.id === chatId && topicId(item.message) === thread && groupIds.has(item.message.media_group_id)) indexes.push(i)
    }
    indexes.sort((a, b) => a - b)
  }

  const batch = indexes.map((index) => pending[index])
  const hasFile = batch.some((item) => item.message.media_group_id || attachments(item.message).length)
  const newest = Math.max(...batch.map((item) => item.at))
  if (hasFile && Date.now() - newest < 2500) return null

  const messages = batch.map((item) => item.message).sort((a, b) => a.message_id - b.message_id)
  for (let i = indexes.length - 1; i >= 0; i--) pending.splice(indexes[i], 1)
  return { messages }
}

async function handleJoin(state, update) {
  const member = update.my_chat_member
  const status = member?.new_chat_member?.status
  const chat = member?.chat
  const userId = String(member?.from?.id || "")
  if (!chat || chat.type === "private") return
  if (status !== "member" && status !== "administrator") return
  if (userId !== OWNER_ID) return
  const current = ensureChat(state, chat)
  saveState(state)
  await beginChat(state, current, chat.id)
}

async function handleMessage(state, messages) {
  const list = Array.isArray(messages) ? messages : [messages]
  const message = list[0]
  const chatId = message.chat?.id
  const userId = String(message.from?.id || "")
  const chatType = message.chat?.type
  if (!chatId || !userId) return
  if (chatType !== "private" && chatType !== "group" && chatType !== "supergroup") return
  noteForumTopic(state, message)
  if (userId !== OWNER_ID) return

  if (list.length === 1 && list[0]._bridgeEdited) {
    const edited = list[0]
    const waitingIndex = jobs.findIndex((job) => job.replyToId === edited.message_id && String(job.chatId) === String(chatId))
    if (waitingIndex !== -1) {
      const raw = (edited.text || edited.caption || "").trim()
      const threadId = topicId(edited)
      if (parseCommand(raw)?.name === "ignore") {
        const [dropped] = jobs.splice(waitingIndex, 1)
        saveQueue()
        if (dropped.statusMessageId) {
          await tg("editMessageText", { chat_id: chatId, message_id: dropped.statusMessageId, text: "Dropped. It will not run." }).catch(() => {})
        }
        await tg("sendMessage", quoted(chatId, edited.message_id, { text: "Ignored. That was not sent on." }, threadId))
        return
      }
      const waiting = jobs[waitingIndex]
      waiting.text = raw
      waiting.files = numberPhotos(attachments(edited))
      waiting.replyQuote = describeReply(edited)
      saveQueue()
      await tg("sendMessage", quoted(chatId, edited.message_id, { text: "Updated the message that's waiting. Claude will get this version." }, threadId))
      return
    }
  }

  if (list.some((item) => parseCommand((item.text || item.caption || "").trim())?.name === "ignore")) {
    await tg("sendMessage", quoted(chatId, message.message_id, { text: "Ignored. That was not sent on." }, topicId(message)))
    return
  }

  const textParts = []
  let skipQueue = false
  for (const item of list) {
    const raw = (item.text || item.caption || "").trim()
    const parsed = parseCommand(raw)
    if (parsed?.name === "skip") {
      skipQueue = true
      if (parsed.arg) textParts.push(parsed.arg)
      continue
    }
    if (raw) textParts.push(raw)
  }
  const text = textParts.join("\n\n")
  const command = !skipQueue && list.length === 1 && message.text ? parseCommand(message.text.trim()) : null
  const files = numberPhotos(list.flatMap(attachments))
  const revised = list.length === 1 && Boolean(list[0]._bridgeEdited)
  const replyQuote = describeReply(message)
  if (!text && !files.length && !command && !replyQuote && !skipQueue) return

  const threadId = topicId(message)
  const current = ensureChat(state, message.chat, threadId, topicTitle(message))
  await learnTopicName(state, current, chatId)
  const label = chatLabel(current, chatKey(chatId, threadId))
  const send = (fields, messageId) => tg("sendMessage", quoted(chatId, messageId, fields, threadId))

  if (skipQueue && !text && !files.length && !replyQuote) {
    await send({ text: "Put the request after /skip." }, message.message_id)
    return
  }

  if (current.awaitingFolderName) {
    const plain = list.length === 1 && !files.length && message.text && !command
    const action = plain ? message.text.trim().toLowerCase() : ""
    if (plain && !["folder", "model", "effort", "speed", "new chat", "status"].includes(action)) {
      await createNamedFolder(state, current, chatId, message.text, message.message_id, threadId)
      return
    }
    current.awaitingFolderName = false
    saveState(state)
  }

  if (!command && list.length === 1 && !files.length && message.text) {
    const action = message.text.trim().toLowerCase()
    if (action === "folder") {
      current.browse = current.workdir || WORKDIR
      current.folderPage = 0
      await showFolders(state, current, chatId, undefined, threadId)
      return
    }
    if (action === "model") {
      await send({ text: "Choose a model.", reply_markup: modelMarkup(current.model) })
      return
    }
    if (action === "effort") {
      await send({ text: "Choose an effort.", reply_markup: effortMarkup(current.effort) })
      return
    }
    if (action === "speed") {
      await send({ text: "Choose a speed. Fast is the default, and it applies to Opus.", reply_markup: speedMarkup(current.speed) })
      return
    }
    if (action === "new chat") {
      if (!current.workdir) {
        current.browse = WORKDIR
        current.folderPage = 0
        await send({ text: "Choose a folder before this chat can start.", reply_markup: actionsMarkup() }, message.message_id)
        await showFolders(state, current, chatId, undefined, threadId)
        return
      }
      current.sessionId = null
      saveState(state)
      await send({ text: `Started a fresh session in ${label}.\n${current.workdir}`, reply_markup: actionsMarkup() })
      return
    }
    if (action === "status") {
      await send({ text: statusText(), reply_markup: actionsMarkup() })
      return
    }
  }

  if (command?.name === "start") {
    await beginChat(state, current, chatId, threadId)
    return
  }

  if (command?.name === "status") {
    await send({ text: statusText() })
    return
  }

  if (command?.name === "chats") {
    const lines = Object.entries(state.chats).map(([key, chat]) => describeChat(chat, key))
    lines.push("")
    lines.push("Each topic keeps its own folder. A group without topics stays one conversation.")
    await send({ text: lines.join("\n\n") })
    return
  }

  if (command?.name === "new") {
    if (!current.workdir) {
      current.browse = WORKDIR
      current.folderPage = 0
      await send({ text: "Choose a folder before this chat can start.", reply_markup: actionsMarkup() }, message.message_id)
      await showFolders(state, current, chatId, undefined, threadId)
      return
    }
    current.sessionId = null
    saveState(state)
    await send({ text: `Started a fresh session in ${label}.\n${current.workdir}`, reply_markup: actionsMarkup() })
    return
  }

  if (command?.name === "resume") {
    const sessions = listComputerSessions(state)
    const arg = command.arg.trim().toLowerCase()
    if (!arg) {
      const shown = sessions.slice(0, 12)
      if (!shown.length) {
        await send({ text: "No Claude Code conversations were found on this computer." })
        return
      }
      state.resumeList = shown.map((session) => session.id)
      saveState(state)
      const lines = shown.map((session, index) => {
        const when = formatWhen(session.ts)
        const preview = session.preview || "(no message yet)"
        return `${index + 1}. ${preview}\n${session.project}\n${when}`
      })
      lines.push("")
      lines.push("Continue one here with /resume 1")
      lines.push("Close that chat in Claude Code on the computer first if it is still open.")
      await send({ text: lines.join("\n\n") })
      return
    }
    const listed = state.resumeList || []
    const pickedId = /^\d+$/.test(arg) ? listed[Number(arg) - 1] : sessions.find((session) => session.id.toLowerCase().startsWith(arg))?.id
    const picked = sessions.find((session) => session.id === pickedId)
    if (!picked) {
      await send({ text: "That conversation was not in the list. Send /resume to see it again." })
      return
    }
    current.sessionId = picked.id
    if (picked.project && existsSync(picked.project)) current.workdir = picked.project
    saveState(state)
    await send({
      text: `This Telegram chat will continue that computer conversation.\n\n${picked.preview || picked.id}\n${currentFolder(current)}\n\nSend the next message to keep going. Close the chat in Claude Code on the computer if it is still open.`,
    })
    return
  }

  if (command?.name === "model") {
    const choice = command.arg.toLowerCase()
    if (!choice) {
      await send({ text: "Choose a model.", reply_markup: modelMarkup(current.model) })
      return
    }
    if (choice === "default" || choice === "opus") {
      current.model = choice === "opus" ? "opus" : null
      saveState(state)
      await send({ text: choice === "opus" ? `Model for ${label} set to Opus 5.5.` : `Model for ${label} reset to Opus.` })
      return
    }
    const picked = MODELS[choice]
    if (!picked) {
      await send({ text: "Unknown model.\n\n" + modelHelp(current.model) })
      return
    }
    current.model = picked.id
    saveState(state)
    await send({ text: `Model for ${label} set to ${picked.label}.` })
    return
  }

  if (command?.name === "effort") {
    const choice = command.arg.toLowerCase()
    if (!choice) {
      await send({ text: "Choose an effort.", reply_markup: effortMarkup(current.effort) })
      return
    }
    if (choice === "default" || choice === "medium") {
      current.effort = choice === "medium" ? "medium" : null
      saveState(state)
      await send({ text: choice === "medium" ? `Effort for ${label} set to medium.` : `Effort for ${label} reset to high.` })
      return
    }
    if (!EFFORTS.includes(choice)) {
      await send({ text: "Unknown effort.\n\n" + effortHelp(current.effort) })
      return
    }
    current.effort = choice
    saveState(state)
    await send({ text: `Effort for ${label} set to ${choice}.` })
    return
  }

  if (command?.name === "speed") {
    const choice = command.arg.toLowerCase()
    if (!choice) {
      await send({ text: "Choose a speed. Fast is the default, and it applies to Opus.", reply_markup: speedMarkup(current.speed) })
      return
    }
    if (choice === "default" || choice === "fast") {
      current.speed = null
      saveState(state)
      await send({ text: `Speed for ${label} set to Fast.` })
      return
    }
    if (choice === "off" || choice === "standard") {
      current.speed = "off"
      saveState(state)
      await send({ text: `Speed for ${label} set to Standard.` })
      return
    }
    await send({ text: "Unknown speed. Choose Fast or Standard.", reply_markup: speedMarkup(current.speed) })
    return
  }

  if (command?.name === "folder") {
    const here = currentFolder(current)
    const choice = command.arg.replace(/^["']|["']$/g, "")
    const parent = dirname(here)
    const kids = childFolders(here)
    const applyFolder = async (folderPath) => {
      current.workdir = folderPath
      current.sessionId = null
      current.folderList = null
      saveState(state)
      await send({ text: `Folder for ${label} set. The next message starts fresh in:\n${folderPath}` })
    }
    if (!choice) {
      current.browse = here
      current.folderPage = 0
      await showFolders(state, current, chatId, undefined, threadId)
      return
    }
    if (choice === "default") {
      await applyFolder(WORKDIR)
      return
    }
    if (choice === ".." || choice === "0") {
      if (!parent || parent === here) {
        await send({ text: "Already at the top folder." })
        return
      }
      await applyFolder(parent)
      return
    }
    if (/^\d+$/.test(choice)) {
      const picked = current.folderList?.[Number(choice)]
      if (!picked || !existsSync(picked)) {
        await send({ text: "Send /folder first, then pick a number from that list." })
        return
      }
      await applyFolder(picked)
      return
    }
    if (!choice.includes("\\") && !choice.includes("/") && !/^[a-zA-Z]:/.test(choice)) {
      const lower = choice.toLowerCase()
      const matches = kids.filter((name) => name.toLowerCase() === lower || name.toLowerCase().startsWith(lower))
      if (matches.length === 1) {
        await applyFolder(join(here, matches[0]))
        return
      }
      if (matches.length > 1) {
        await send({ text: `Several folders match:\n${matches.join("\n")}\n\nSend /folder and pick the number.` })
        return
      }
    }
    const full = resolve(choice)
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      await send({ text: `No folder named that in:\n${here}` })
      return
    }
    await applyFolder(full)
    return
  }

  if (!current.workdir) {
    current.browse = WORKDIR
    current.folderPage = 0
    await send({ text: "Choose a folder before this chat can start.", reply_markup: actionsMarkup() }, message.message_id)
    await showFolders(state, current, chatId, undefined, threadId)
    return
  }

  const busy = Boolean(active) || jobs.length > 0
  const sameChat = active && String(active.chatId) === String(chatId) && (active.threadId || 0) === (threadId || 0)
  const notice = revised && busy
    ? "Got the edited text. It will run after the one already going."
    : !busy
    ? `Working in ${label}.`
    : skipQueue
      ? "This will run next, as soon as the current one finishes."
      : sameChat
        ? "Queued behind the message already running in this chat."
        : `Queued. Working in ${active?.title || jobs[0]?.title || "another chat"} first.`
  const replyToId = message.message_id
  const jobId = Math.random().toString(36).slice(2, 10)
  let statusMessageId = null
  try {
    const sent = await send({ text: notice, reply_markup: busy ? queueMarkup(jobId) : actionsMarkup() }, replyToId)
    statusMessageId = sent?.message_id || null
  } catch (err) {
    console.error("status send failed", err.message || err)
  }
  console.log(busy ? (skipQueue ? "skip" : "queued") : "working", label, files.length ? `${files.length} file` : "text", text ? `caption ${text.length}` : "no caption")
  const job = { id: jobId, chatId, title: label, text, files, replyQuote, current, queued: busy, statusMessageId, replyToId, threadId, interrupted: false }
  if (skipQueue && busy) jobs.unshift(job)
  else jobs.push(job)
  saveQueue()
  kickWorker(state)
}

const jobs = []
let workerRunning = false
let active = null
let activeJob = null

function snapshotJob(job, interrupted) {
  return {
    id: job.id,
    chatId: job.chatId,
    title: job.title,
    text: job.text || "",
    files: job.files || [],
    replyQuote: job.replyQuote ? { text: job.replyQuote.text || "", files: job.replyQuote.files || [] } : null,
    statusMessageId: job.statusMessageId || null,
    replyToId: job.replyToId || null,
    threadId: job.threadId || null,
    chatKey: chatKey(job.chatId, job.threadId),
    interrupted: Boolean(interrupted),
  }
}

function saveQueue() {
  const list = []
  if (activeJob) list.push(snapshotJob(activeJob, true))
  for (const job of jobs) list.push(snapshotJob(job, Boolean(job.interrupted)))
  try {
    writeFileSync(QUEUE_FILE, JSON.stringify(list, null, 2))
  } catch (err) {
    console.error("queue save failed", err.message || err)
  }
}

function loadQueue(state) {
  let list = []
  try {
    list = JSON.parse(readFileSync(QUEUE_FILE, "utf8"))
  } catch {
    return
  }
  if (!Array.isArray(list)) return
  for (const saved of list) {
    const current = state.chats?.[saved.chatKey]
    if (!current || saved.chatId == null) continue
    jobs.push({
      id: saved.id || Math.random().toString(36).slice(2, 10),
      chatId: saved.chatId,
      title: saved.title || chatLabel(current, saved.chatKey),
      text: saved.text || "",
      files: Array.isArray(saved.files) ? saved.files : [],
      replyQuote: saved.replyQuote || null,
      current,
      queued: true,
      statusMessageId: saved.statusMessageId || null,
      replyToId: saved.replyToId || null,
      threadId: saved.threadId || null,
      interrupted: Boolean(saved.interrupted),
    })
  }
}

function statusText() {
  if (!active && !jobs.length) return "Idle. No chat is being processed."
  const lines = []
  if (active) {
    lines.push(`Working in ${active.title}.`)
    lines.push(formatElapsed(Date.now() - (active.startedAt || Date.now())))
    if (active.task) lines.push(active.task)
    const steps = active.steps || []
    if (!steps.length) lines.push("Now: starting.")
    else {
      lines.push(`Now: ${steps[steps.length - 1]}`)
      const recent = steps.slice(0, -1).slice(-5)
      if (recent.length) lines.push(["Recent:", ...recent.map((step) => `• ${step}`)].join("\n"))
    }
  }
  if (jobs.length) {
    lines.push("")
    lines.push("Waiting:")
    jobs.forEach((job, index) => {
      const task = taskPreview(job)
      lines.push(task ? `${index + 1}. ${job.title}\n${task}` : `${index + 1}. ${job.title}`)
    })
  }
  return lines.join("\n\n")
}

function pushStep(job, step) {
  if (!step) return
  if (!job.steps) job.steps = []
  if (job.steps[job.steps.length - 1] === step) return
  job.steps.push(step)
  if (job.steps.length > 8) job.steps.shift()
  if (active && String(active.chatId) === String(job.chatId) && (active.threadId || 0) === (job.threadId || 0)) {
    active.step = step
    active.steps = job.steps
  }
}

async function publishActivity(job, step) {
  pushStep(job, step)
  if (!job.statusMessageId) return
  const text = activityText(job)
  if (text === job.lastActivity) return
  const now = Date.now()
  if (job.lastEdit && now - job.lastEdit < 4000) {
    job.pendingStep = step
    if (!job.editTimer) {
      job.editTimer = setTimeout(() => {
        job.editTimer = null
        const next = job.pendingStep
        job.pendingStep = ""
        if (next) publishActivity(job, next).catch(() => {})
      }, 4000 - (now - job.lastEdit))
    }
    return
  }
  job.lastActivity = text
  job.lastEdit = now
  await tg("editMessageText", { chat_id: job.chatId, message_id: job.statusMessageId, text }).catch(() => {})
}

function clearActivityTimer(job) {
  if (job.editTimer) clearTimeout(job.editTimer)
  job.editTimer = null
  job.pendingStep = ""
}

function kickWorker(state) {
  if (workerRunning) return
  workerRunning = true
  runWorker(state)
}

async function runWorker(state) {
  try {
    while (jobs.length) {
      const job = jobs.shift()
      job.startedAt = Date.now()
      job.steps = []
      activeJob = job
      active = { jobId: job.id, chatId: job.chatId, threadId: job.threadId, title: job.title, task: taskPreview(job), step: "Starting", steps: job.steps, startedAt: job.startedAt }
      saveQueue()
      try {
        await publishActivity(job, "Starting")
        await runJob(state, job)
      } catch (err) {
        console.error("job error", err.message || err)
        await tg("sendMessage", quoted(job.chatId, job.replyToId, { text: `Could not reach Claude Code: ${err.message || err}` }, job.threadId)).catch(() => {})
      } finally {
        clearActivityTimer(job)
        activeJob = null
        saveQueue()
      }
      active = null
    }
  } finally {
    active = null
    workerRunning = false
  }
}

async function runJob(state, job) {
  const { chatId, text, files, current, replyToId, threadId } = job
  let saved = []
  if (files.length) {
    const dir = join(STATE_DIR, "inbox", String(chatId), threadId ? String(threadId) : "chat")
    try {
      for (const file of files) {
        const path = await downloadTelegram(file.fileId, dir, file.name)
        saved.push({ kind: file.kind, name: file.name, path })
        console.log("saved", file.kind, file.name || "", path)
      }
    } catch (err) {
      const tooBig = /too big/i.test(String(err.message || err))
      await tg("sendMessage", quoted(chatId, replyToId, {
        text: tooBig
          ? "That file is over 20 MB, which is the largest Telegram lets this bot download. Send a smaller one, or put the file in the project folder and tell me the path."
          : `Could not download that file: ${err.message || err}`,
      }, threadId))
      return
    }
  }

  const quoteSaved = []
  if (job.replyQuote?.files?.length) {
    const dir = join(STATE_DIR, "inbox", String(chatId), threadId ? String(threadId) : "chat")
    for (const file of job.replyQuote.files) {
      try {
        const path = await downloadTelegram(file.fileId, dir, file.name)
        quoteSaved.push({ kind: file.kind, name: file.name, path })
      } catch (err) {
        quoteSaved.push({ kind: file.kind, name: file.name, note: err.message || "could not download" })
      }
    }
  }

  const inlined = saved.map((item) => readTextAttachment(item.path, item.name)).filter(Boolean)
  const promptText = [text, ...inlined].filter(Boolean).join("\n\n")
  let prompt = attachmentPrompt(promptText, saved, job.replyQuote ? { ...job.replyQuote, saved: quoteSaved } : null)
  if (job.interrupted) {
    prompt = `The computer restarted while you were working. Continue that unfinished work from where you left off. Do not start over.\n\nOriginal request:\n${prompt}`
  }
  const typingBody = { chat_id: chatId, action: "typing" }
  if (threadId) typingBody.message_thread_id = threadId
  await tg("sendChatAction", typingBody)
  const typing = setInterval(() => {
    tg("sendChatAction", typingBody).catch(() => {})
  }, 4000)

  try {
    const stdout = await runClaude(prompt, current.sessionId, current.model, current.effort, current.speed, currentFolder(current), (step) => {
      publishActivity(job, step).catch(() => {})
    })
    const parsed = parseClaude(stdout)
    if (parsed.session_id) {
      current.sessionId = parsed.session_id
      saveState(state)
    }
    const reply = parsed.is_error ? `Claude Code error: ${parsed.result || "unknown"}` : parsed.result || ""
    const outbound = takeOutboundFiles(reply)
    if (outbound.text) await sendChunks(chatId, outbound.text, replyToId, threadId)
    for (const file of outbound.files) {
      try {
        await sendOutboundFile(chatId, threadId, replyToId, file)
      } catch (err) {
        await tg("sendMessage", quoted(chatId, replyToId, { text: `Could not send ${basename(file.filePath)}: ${err.message || err}` }, threadId))
      }
    }
    if (!outbound.text && !outbound.files.length) await sendChunks(chatId, "(no reply)", replyToId, threadId)
  } catch (err) {
    await tg("sendMessage", quoted(chatId, replyToId, { text: `Could not reach Claude Code: ${err.message || err}` }, threadId))
  } finally {
    clearInterval(typing)
  }
}

async function handleCallback(state, query) {
  const userId = String(query.from?.id || "")
  const data = String(query.data || "")
  const message = query.message
  const chatId = message?.chat?.id
  const done = (text) => tg("answerCallbackQuery", text ? { callback_query_id: query.id, text: String(text).slice(0, 180) } : { callback_query_id: query.id }).catch(() => {})
  if (userId !== OWNER_ID || !chatId) {
    await done()
    return
  }
  const threadId = topicId(message)
  const current = ensureChat(state, message.chat, threadId, topicTitle(message))
  await learnTopicName(state, current, chatId)
  const label = chatLabel(current, chatKey(chatId, threadId))
  try {
    if (data === "f:new") {
      const parent = current.browse || current.workdir || WORKDIR
      current.awaitingFolderName = true
      current.pendingFolderParent = parent
      saveState(state)
      await tg("sendMessage", quoted(chatId, undefined, { text: `Send a name for the new folder. It will be created in:\n${parent}` }, threadId))
      await done("Send the folder name")
      return
    }
    if (data === "f:use") {
      const folderPath = current.browse || current.workdir || WORKDIR
      if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
        await done("That folder is not on this computer.")
        return
      }
      current.workdir = folderPath
      current.browse = folderPath
      current.sessionId = null
      current.folderList = null
      current.folderPage = 0
      saveState(state)
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: message.message_id,
        text: `Folder set. The next message starts fresh in:\n${folderPath}`,
      }).catch(() => {})
      await done("Folder set")
      return
    }
    if (data.startsWith("f:page:")) {
      current.folderPage = Number(data.slice("f:page:".length)) || 0
      await showFolders(state, current, chatId, message.message_id, threadId)
      await done()
      return
    }
    if (data.startsWith("f:")) {
      const picked = current.folderList?.[Number(data.slice(2))]
      if (!picked || !existsSync(picked)) {
        current.browse = current.workdir || WORKDIR
        current.folderPage = 0
        await showFolders(state, current, chatId, message.message_id, threadId)
        await done("Showing the list again.")
        return
      }
      current.browse = picked
      current.folderPage = 0
      await showFolders(state, current, chatId, message.message_id, threadId)
      await done()
      return
    }
    if (data.startsWith("m:")) {
      const picked = MODELS[data.slice(2)]
      if (!picked) {
        await done("Unknown model.")
        return
      }
      current.model = picked.id
      saveState(state)
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: message.message_id,
        text: `Model for ${label} set to ${picked.label}.`,
      }).catch(() => {})
      await done(picked.label)
      return
    }
    if (data.startsWith("e:")) {
      const choice = data.slice(2)
      if (!EFFORTS.includes(choice)) {
        await done("Unknown effort.")
        return
      }
      current.effort = choice
      saveState(state)
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: message.message_id,
        text: `Effort for ${label} set to ${choice}.`,
      }).catch(() => {})
      await done(choice)
      return
    }
    if (data.startsWith("s:")) {
      const choice = data.slice(2)
      if (choice !== "fast" && choice !== "off") {
        await done("Unknown speed.")
        return
      }
      current.speed = choice === "off" ? "off" : null
      saveState(state)
      const labelSpeed = choice === "off" ? "Standard" : "Fast"
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: message.message_id,
        text: `Speed for ${label} set to ${labelSpeed}.`,
      }).catch(() => {})
      await done(labelSpeed)
      return
    }
    if (data.startsWith("q:")) {
      const [, action, id] = data.split(":")
      const index = jobs.findIndex((job) => job.id === id)
      if (index === -1) {
        await done(active?.jobId === id ? "Already running." : "That message is no longer waiting.")
        return
      }
      const [job] = jobs.splice(index, 1)
      if (action === "drop") {
        if (job.statusMessageId) {
          await tg("editMessageText", { chat_id: chatId, message_id: job.statusMessageId, text: "Dropped. It will not run." }).catch(() => {})
        }
        saveQueue()
        await done("Dropped")
        return
      }
      jobs.unshift(job)
      saveQueue()
      if (job.statusMessageId) {
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: job.statusMessageId,
          text: "This will run next, as soon as the current one finishes.",
          reply_markup: queueMarkup(job.id),
        }).catch(() => {})
      }
      await done("Running next")
      return
    }
    await done()
  } catch (err) {
    console.error("callback error", err.message || err)
    await done(err.message || err)
  }
}

async function publishCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "status", description: "Show which chat is being processed" },
      { command: "resume", description: "Continue a Claude Code chat from this computer" },
      { command: "chats", description: "List group and private conversations" },
      { command: "folder", description: "Choose a folder with buttons" },
      { command: "model", description: "Choose Opus, Sonnet, or Fable" },
      { command: "effort", description: "Set effort: low, medium, high, xhigh, max" },
      { command: "speed", description: "Fast or Standard. Fast is the default" },
      { command: "new", description: "Start this conversation over" },
      { command: "ignore", description: "Do not send this message to Claude" },
      { command: "skip", description: "Run this message next, ahead of the queue" },
      { command: "start", description: "How this bot works" },
    ],
  })
}

async function main() {
  const state = loadState()
  saveState(state)
  try {
    await publishCommands()
  } catch (err) {
    console.error("menu update failed", err.message || err)
  }
  loadQueue(state)
  if (jobs.length) {
    console.log("restoring", jobs.length, "job(s)")
    for (const job of jobs) {
      const note = job.interrupted
        ? "The computer restarted. Continuing this from where it left off."
        : "The computer restarted. This is still in line and will run without you resending."
      try {
        const sent = await tg("sendMessage", quoted(job.chatId, job.replyToId, { text: note, reply_markup: actionsMarkup() }, job.threadId))
        job.statusMessageId = sent?.message_id || job.statusMessageId
      } catch (err) {
        console.error("restore notice failed", err.message || err)
      }
    }
    saveQueue()
    kickWorker(state)
  }
  console.log("telegram bridge listening")
  const pending = []
  for (;;) {
    let updates = []
    try {
      updates = await tg("getUpdates", {
        offset: state.offset || undefined,
        timeout: pending.length ? 1 : 25,
        allowed_updates: ["message", "edited_message", "my_chat_member", "callback_query"],
      })
    } catch (err) {
      console.error("poll error", err.message || err)
      await new Promise((r) => setTimeout(r, 3000))
      continue
    }
    for (const update of updates) {
      state.offset = update.update_id + 1
      saveState(state)
      if (update.callback_query) pending.push({ callback: update.callback_query, at: Date.now() })
      else if (update.my_chat_member) pending.push({ join: update, at: Date.now() })
      else if (update.message) pending.push({ message: update.message, at: Date.now() })
      else if (update.edited_message) {
        const edited = update.edited_message
        edited._bridgeEdited = true
        const idx = pending.findIndex((item) => item.message && item.message.chat?.id === edited.chat?.id && item.message.message_id === edited.message_id)
        if (idx !== -1) {
          pending[idx].message = edited
          pending[idx].at = Date.now()
        } else pending.push({ message: edited, at: Date.now() })
      }
    }
    for (;;) {
      const next = takeReady(pending)
      if (!next) break
      try {
        if (next.callback) await handleCallback(state, next.callback)
        else if (next.join) await handleJoin(state, next.join)
        else await handleMessage(state, next.messages)
      } catch (err) {
        console.error("update error", err.message || err)
      }
    }
  }
}

if (process.env.BRIDGE_FORMAT_TEST !== "1") {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export { markdownToTelegramHtml, splitMessage }
