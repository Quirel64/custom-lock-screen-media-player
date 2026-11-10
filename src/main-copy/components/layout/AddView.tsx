import { motion } from 'framer-motion'

interface AddViewProps {
  onPickFolder: () => void
  onPickFiles: () => void
}

export function AddView({ onPickFolder, onPickFiles }: AddViewProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center"
      >
        <div className="mb-4 text-6xl">🎵</div>
        <h2 className="mb-2 text-xl font-bold text-white">Add Music</h2>
        <p className="mb-8 text-sm text-slate-400">
          Choose how you'd like to add your music
        </p>
      </motion.div>

      <div className="flex w-full max-w-sm flex-col gap-4">
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onPickFolder}
          className="flex items-center gap-4 rounded-xl border border-slate-700 bg-slate-800/50 p-5 text-left transition-colors hover:border-primary/50 hover:bg-slate-800"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/20 text-2xl">
            📁
          </div>
          <div>
            <p className="font-medium text-white">Open Folder</p>
            <p className="text-xs text-slate-400">
              Select a folder containing your music
            </p>
          </div>
        </motion.button>

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onPickFiles}
          className="flex items-center gap-4 rounded-xl border border-slate-700 bg-slate-800/50 p-5 text-left transition-colors hover:border-accent/50 hover:bg-slate-800"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent/20 text-2xl">
            🎶
          </div>
          <div>
            <p className="font-medium text-white">Select Files</p>
            <p className="text-xs text-slate-400">
              Pick multiple audio files at once
            </p>
          </div>
        </motion.button>
      </div>

      <p className="mt-4 max-w-xs text-center text-xs text-slate-600">
        Supported formats: MP3, WAV, OGG, FLAC, M4A, AAC, WMA, OPUS, MP4, WebM, MKV, MOV, AVI
      </p>
    </div>
  )
}
