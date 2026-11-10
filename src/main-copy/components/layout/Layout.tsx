import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import type { TabId } from './BottomNav'
import { BottomNav } from './BottomNav'

interface LayoutProps {
  sidebar: ReactNode
  nowPlaying: ReactNode
  content: ReactNode
  player: ReactNode
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  trackCount: number
}

export function Layout({ sidebar, nowPlaying, content, player, activeTab, onTabChange, trackCount }: LayoutProps) {
  return (
    <div className="flex h-full flex-col bg-slate-950">
      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <motion.aside
          initial={{ x: -260 }}
          animate={{ x: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="hidden w-64 flex-shrink-0 flex-col border-r border-slate-800 bg-slate-900 md:flex"
        >
          {sidebar}
        </motion.aside>

        {/* Main content - nowPlaying fixed, content scrolls */}
        <main className="flex-1 flex flex-col overflow-hidden bg-slate-950">
          <div className="flex-shrink-0 border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-10">
            {nowPlaying}
          </div>
          <div className="flex-1 overflow-y-auto">
            {content}
          </div>
        </main>
      </div>

      {/* Player bar */}
      <motion.div
        initial={{ y: 90 }}
        animate={{ y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.1 }}
        className="flex-shrink-0 border-t border-slate-800 bg-slate-900"
      >
        {player}
      </motion.div>

      {/* Mobile bottom nav */}
      <BottomNav activeTab={activeTab} onTabChange={onTabChange} trackCount={trackCount} />
    </div>
  )
}