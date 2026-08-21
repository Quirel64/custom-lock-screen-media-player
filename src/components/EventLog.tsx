interface EventLogProps {
  entries: string[];
  onClear: () => void;
}

export default function EventLog({ entries, onClear }: EventLogProps) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-black/40 backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-semibold text-white/80">Live event log</h3>
        <button
          onClick={onClear}
          className="rounded-md px-2 py-1 text-xs text-white/50 transition hover:bg-white/10 hover:text-white"
        >
          Clear
        </button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto px-4 py-3 font-mono text-[11px] leading-relaxed text-emerald-300/90">
        {entries.length === 0 && (
          <p className="text-white/30">
            Actions from your lock screen / control center will appear here (play, pause,
            seek, skip, next/prev)...
          </p>
        )}
        {entries.map((entry, i) => (
          <div key={i} className="whitespace-pre-wrap break-words">
            {entry}
          </div>
        ))}
      </div>
    </div>
  );
}
