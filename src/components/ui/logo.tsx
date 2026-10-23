/** The mark: a sunken court holding water, on a tomato tile. */
export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-9 place-items-center rounded-[10px] border-[1.5px] border-foreground bg-primary shadow-[2px_2px_0_0_var(--foreground)]">
        <svg viewBox="0 0 32 32" className="size-6">
          {/* a sunken court holding water: the mark */}
          <path d="M5 11 h22 v12 a2 2 0 0 1 -2 2 h-18 a2 2 0 0 1 -2 -2z" fill="#fff" stroke="#161514" strokeWidth="1.8" />
          <path d="M5 18 q 5.5 -2.5 11 0 t 11 0 V23 a2 2 0 0 1 -2 2 h-18 a2 2 0 0 1 -2 -2z" fill="#3d6cf5" stroke="#161514" strokeWidth="1.8" />
          <path d="M16 11 v7" stroke="#161514" strokeWidth="1.4" />
          <circle cx="16" cy="14.2" r="2.2" fill="none" stroke="#161514" strokeWidth="1.4" />
          <path d="M9 7 l-1 2 M16 6 l-1 2 M23 7 l-1 2" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </div>
      <div className="leading-tight">
        <div className="font-display text-[15px] font-bold tracking-tight text-foreground">Sponge Township</div>
      </div>
    </div>
  );
}
