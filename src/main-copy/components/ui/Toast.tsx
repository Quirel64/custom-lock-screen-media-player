import { useState, useCallback, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

interface Toast {
  id: number
  message: string
  type: 'error' | 'info' | 'success'
}

let toastId = 0
let addToastFn: ((message: string, type?: 'error' | 'info' | 'success') => void) | null = null

export function showError(message: string) {
  addToastFn?.(message, 'error')
  console.error('[App Error]', message)
}

export function showInfo(message: string) {
  addToastFn?.(message, 'info')
  console.log('[App Info]', message)
}

export function showSuccess(message: string) {
  addToastFn?.(message, 'success')
  console.log('[App Success]', message)
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((message: string, type: 'error' | 'info' | 'success' = 'error') => {
    const id = ++toastId
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4000)
  }, [])

  useEffect(() => {
    addToastFn = addToast
    return () => { addToastFn = null }
  }, [addToast])

  const bgColor = (type: string) => {
    switch (type) {
      case 'error': return 'bg-red-600'
      case 'success': return 'bg-green-600'
      default: return 'bg-slate-700'
    }
  }

  return (
    <div className="fixed bottom-20 left-4 right-4 z-50 flex flex-col gap-2 md:left-auto md:right-4 md:w-96">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            className={`${bgColor(toast.type)} rounded-lg px-4 py-3 text-sm text-white shadow-lg`}
          >
            <p className="font-medium">{toast.type === 'error' ? 'Error' : toast.type === 'success' ? 'Success' : 'Info'}</p>
            <p className="mt-1 text-xs opacity-90">{toast.message}</p>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
