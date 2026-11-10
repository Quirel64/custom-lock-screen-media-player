type Listener = (entries: string[]) => void

let entries: string[] = []
let listeners = new Set<Listener>()

function notify() {
  for (const l of listeners) l([...entries])
}

export function addLog(msg: string) {
  const time = new Date().toLocaleTimeString()
  const line = `[${time}] ${msg}`
  entries = [...entries.slice(-199), line]
  console.log(line)
  notify()
}

export function getLogs() {
  return [...entries]
}

export function clearLogs() {
  entries = []
  notify()
}

export function subscribeLogs(listener: Listener): () => void {
  listeners.add(listener)
  listener([...entries])
  return () => listeners.delete(listener)
}
