/** The mark: a sponge soaking up water, with the wordmark. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <clipPath id="logo-tile">
          <rect x="4" y="4" width="52" height="52" rx="14" />
        </clipPath>
      </defs>
      <rect x="8" y="8" width="52" height="52" rx="14" fill="#161514" />
      <rect x="4" y="4" width="52" height="52" rx="14" fill="#ffd84d" />
      <g fill="#e8b92c">
        <circle cx="16" cy="16" r="3.4" />
        <circle cx="29.5" cy="12.5" r="2.2" />
        <circle cx="43" cy="17" r="3.8" />
        <circle cx="22.5" cy="26.5" r="2.4" />
        <circle cx="36" cy="27" r="2" />
        <circle cx="48" cy="29" r="1.6" />
        <circle cx="11.5" cy="29" r="1.5" />
      </g>
      <g clipPath="url(#logo-tile)">
        <path d="M0 37 C 8 31.5, 15 31.5, 22 36 S 37 41, 44 36 S 58 31.5, 64 35 V64 H0Z" fill="#3d6cf5" />
        <path d="M0 37 C 8 31.5, 15 31.5, 22 36 S 37 41, 44 36 S 58 31.5, 64 35" fill="none" stroke="#161514" strokeWidth="3" />
        <path d="M10 45 h10 M31 49 h8" stroke="#dbe6ff" strokeWidth="2.6" strokeLinecap="round" />
      </g>
      <rect x="4" y="4" width="52" height="52" rx="14" fill="none" stroke="#161514" strokeWidth="3.2" />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="group flex items-center gap-2.5">
      <LogoMark className="size-9 transition-transform duration-300 group-hover:-rotate-6" />
      <div className="font-display text-[15px] font-bold tracking-tight text-foreground">Sponge Township</div>
    </div>
  );
}
