import { motion } from 'framer-motion'

export type TabId = 'add' | 'library' | 'playlists' | 'logs'

interface BottomNavProps {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  trackCount: number
}

const tabs: { id: TabId; label: string; icon: string }[] = [
  { id: 'add', label: 'Add', icon: '+' },
  { id: 'library', label: 'Library', icon: '♫' },
  { id: 'playlists', label: 'Playlists', icon: '📋' },
  { id: 'logs', label: 'Logs', icon: '≡' },
]

export function BottomNav({ activeTab, onTabChange, trackCount }: BottomNavProps) {
  return (
    <nav className="flex items-center border-t border-slate-800 bg-slate-900 md:hidden">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className="relative flex flex-1 flex-col items-center gap-0.5 py-3"
        >
          <span
            className={`text-lg ${
              activeTab === tab.id ? 'text-primary' : 'text-slate-500'
            }`}
          >
            {tab.id === 'library' && trackCount > 0 ? (
              <span className="relative">
                {tab.icon}
                <span className="absolute -right-2 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-white">
                  {trackCount > 99 ? '99+' : trackCount}
                </span>
              </span>
            ) : (
              tab.icon
            )}
          </span>
          <span
            className={`text-[10px] ${
              activeTab === tab.id ? 'text-primary' : 'text-slate-500'
            }`}
          >
            {tab.label}
          </span>
          {activeTab === tab.id && (
            <motion.div
              layoutId="activeTab"
              className="absolute -bottom-px left-1/4 right-1/4 h-0.5 bg-primary"
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            />
          )}
        </button>
      ))}
    </nav>
  )
}
