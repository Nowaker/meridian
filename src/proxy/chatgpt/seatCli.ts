/**
 * `meridian profile ...` for ChatGPT seats.
 *
 * A Claude profile lives in files a CLI may edit; a ChatGPT seat does not. The
 * running instance holds its store's writer lease for as long as it runs, so a
 * second process writing the store would be exactly the second writer the
 * lease exists to forbid. These commands therefore ask the running instance,
 * through the same routes the web UI uses, and print what it answered. No
 * response they read carries a token.
 *
 * This is a leaf module: it imports nothing from server.ts or session/.
 */

const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const GREY = "\x1b[90m"
const RESET = "\x1b[0m"

export interface ChatGptSeatEntry {
  id: string
  label?: string
  email?: string | null
  planName?: string | null
  planTier?: "free" | "paid" | null
  isActive?: boolean
  loggedIn?: boolean
  tokenState?: string
  aliases?: string[]
  freeSeatDeferred?: { servedFirstBy: string[] } | null
}

export interface SeatCliIo {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  log: (line: string) => void
  error: (line: string) => void
  sleep: (ms: number) => Promise<void>
}

const defaultIo: SeatCliIo = {
  fetch: (url, init) => fetch(url, init),
  log: line => console.log(line),
  error: line => console.error(line),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

export function runningInstanceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = env.MERIDIAN_PORT ?? env.CLAUDE_PROXY_PORT ?? "3456"
  const host = env.MERIDIAN_HOST ?? env.CLAUDE_PROXY_HOST ?? "127.0.0.1"
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`
}

function headers(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = env.MERIDIAN_API_KEY
  return { "Content-Type": "application/json", ...(key ? { "x-api-key": key } : {}) }
}

async function call(io: SeatCliIo, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> } | null> {
  try {
    const res = await io.fetch(`${runningInstanceUrl()}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    return { status: res.status, data }
  } catch {
    return null
  }
}

/** The running instance's ChatGPT seats; null when it cannot be reached. */
export async function fetchChatGptSeats(io: SeatCliIo = defaultIo): Promise<ChatGptSeatEntry[] | null> {
  const reply = await call(io, "/profiles/list")
  if (!reply || reply.status !== 200) return null
  const profiles = Array.isArray(reply.data.profiles) ? reply.data.profiles as Array<Record<string, unknown>> : []
  return profiles.filter(p => p.type === "chatgpt") as unknown as ChatGptSeatEntry[]
}

/** The seat a name means, by current id or former id; undefined when none. */
export function findSeat(seats: readonly ChatGptSeatEntry[], id: string): ChatGptSeatEntry | undefined {
  return seats.find(seat => seat.id === id) ?? seats.find(seat => seat.aliases?.includes(id))
}

export function printChatGptSeats(seats: readonly ChatGptSeatEntry[], io: SeatCliIo = defaultIo): void {
  if (seats.length === 0) return
  io.log("ChatGPT seats (from the running instance):\n")
  for (const seat of seats) {
    const plan = seat.planName ? ` ${seat.planName}${seat.planTier === "free" ? ", free" : ""}` : ""
    const status = seat.loggedIn
      ? `${GREEN}✓ ${seat.email ?? seat.label ?? ""}${plan ? ` (${plan.trim()})` : ""}${RESET}`
      : `${RED}✗ needs login (${seat.tokenState ?? "unknown"})${RESET}`
    io.log(`  ${seat.id.padEnd(20)} ${status}${seat.isActive ? " [active]" : ""}`)
    if (seat.aliases && seat.aliases.length > 0) io.log(`  ${"".padEnd(20)} ${GREY}also answers to: ${seat.aliases.join(", ")}${RESET}`)
    if (seat.freeSeatDeferred) io.log(`  ${"".padEnd(20)} ${GREY}free plan: ${seat.freeSeatDeferred.servedFirstBy.join(", ")} serve${seat.freeSeatDeferred.servedFirstBy.length === 1 ? "s" : ""} unpinned work first${RESET}`)
  }
  io.log("")
}

function unreachable(io: SeatCliIo): false {
  io.error(`${RED}✗ Could not reach Meridian at ${runningInstanceUrl()}. Is it running?${RESET}`)
  return false
}

export async function removeChatGptSeat(id: string, io: SeatCliIo = defaultIo): Promise<boolean> {
  const reply = await call(io, "/profiles/remove", { profile: id })
  if (!reply) return unreachable(io)
  if (reply.status !== 200) {
    io.error(`${RED}✗ ${String(reply.data.error ?? `Remove failed (HTTP ${reply.status}).`)}${RESET}`)
    return false
  }
  io.log(`${GREEN}✓ ChatGPT seat "${String(reply.data.profile)}" removed; its stored credentials are deleted.${RESET}`)
  if (typeof reply.data.activeProfile === "string") io.log(`  Active ChatGPT seat is now "${reply.data.activeProfile}".`)
  else if (reply.data.activeProfile === null) io.log("  No ChatGPT seat is left to be active.")
  return true
}

export async function renameChatGptSeat(from: string, to: string, io: SeatCliIo = defaultIo): Promise<boolean> {
  const reply = await call(io, "/profiles/rename", { from, to })
  if (!reply) return unreachable(io)
  if (reply.status !== 200) {
    io.error(`${RED}✗ ${String(reply.data.error ?? `Rename failed (HTTP ${reply.status}).`)}${RESET}`)
    return false
  }
  const aliases = Array.isArray(reply.data.aliases) ? reply.data.aliases as string[] : [from]
  io.log(`${GREEN}✓ ChatGPT seat "${from}" renamed to "${to}".${RESET}`)
  io.log(`  Requests naming ${aliases.map(a => `"${a}"`).join(", ")} are served by "${to}" until the name is taken again.`)
  return true
}

/**
 * Sign a seat in again by device code, which works from any terminal: the
 * person opens the URL in any browser and types the code. The running
 * instance polls auth.openai.com and refuses the result unless it is that
 * same account and workspace.
 */
export async function loginChatGptSeat(id: string, io: SeatCliIo = defaultIo, pollMs = 3_000): Promise<boolean> {
  const started = await call(io, "/profiles/chatgpt/connect/device", { profile: id })
  if (!started) return unreachable(io)
  if (started.status !== 200) {
    io.error(`${RED}✗ ${String(started.data.error ?? `Could not start the sign-in (HTTP ${started.status}).`)}${RESET}`)
    if (started.data.code !== "unknown_profile") io.error(`  Use Sign in again on the seat's card at ${runningInstanceUrl()}/profiles instead.`)
    return false
  }
  const connectId = String(started.data.connectId)
  io.log(`Sign ChatGPT seat "${id}" in again:`)
  io.log(`  1. Open ${String(started.data.verificationUrl)} in any browser and sign in with the account this seat belongs to.`)
  io.log(`  2. Enter this code there: ${String(started.data.userCode)}  (it expires in 15 minutes)`)
  io.log(`${GREY}Waiting for the code to be entered... (Ctrl-C cancels)${RESET}`)
  for (;;) {
    await io.sleep(pollMs)
    const state = await call(io, `/profiles/chatgpt/connect/status?connectId=${encodeURIComponent(connectId)}`)
    if (!state) continue
    const status = state.data.status
    if (state.status === 200 && (status === "waiting" || status === "exchanging")) continue
    if (state.status === 200 && status === "completed") {
      io.log(`${GREEN}✓ "${id}" is signed in again${state.data.email ? ` as ${String(state.data.email)}` : ""}.${RESET}`)
      return true
    }
    io.error(`${RED}✗ ${String(state.data.message ?? state.data.error ?? "The sign-in failed.")}${RESET}`)
    return false
  }
}
