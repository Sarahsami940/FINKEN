import { CircleCheck, TriangleAlert, X } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { cn } from './cn';

interface ToastOptions {
  tone?: 'success' | 'error';
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}

type ShowToast = (message: string, options?: ToastOptions) => void;

const ToastContext = createContext<ShowToast>(() => {});

export function useToast(): ShowToast {
  return useContext(ToastContext);
}

const DURATION = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback<ShowToast>(
    (message, options) => {
      const id = nextId.current++;
      // Keep at most two on screen so confirmations never pile up.
      setToasts((list) => [...list.slice(-1), { id, message, ...options }]);
      window.setTimeout(() => dismiss(id), DURATION);
    },
    [dismiss],
  );

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-8">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className="pointer-events-auto flex w-full max-w-sm animate-sheet-in items-center gap-3 rounded-2xl bg-ink py-3 pl-4 pr-2 text-sm font-medium text-white shadow-raised"
          >
            {toast.tone === 'error' ? (
              <TriangleAlert aria-hidden className="size-[18px] shrink-0 text-[#ffb4a8]" />
            ) : (
              <CircleCheck aria-hidden className="size-[18px] shrink-0 text-[#8fe0b6]" />
            )}
            <span className="min-w-0 flex-1">{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  toast.action!.onClick();
                  dismiss(toast.id);
                }}
                className="rounded-lg px-2.5 py-1.5 font-bold text-white underline-offset-2 hover:bg-white/10 hover:underline"
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
              className={cn('flex size-8 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white')}
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
