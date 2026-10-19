/** Shared shadcn/ui theme. Colors come from CSS variables defined in the app's globals.css. */
module.exports = {
  darkMode: ['class', '[data-theme="dark"]'],
  // hover: styles only on devices that can hover, so they don't stick after a tap on a phone.
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        viz: {
          accent: 'var(--viz-accent)',
          track: 'var(--viz-track)',
          grid: 'var(--viz-grid)',
          baseline: 'var(--viz-baseline)',
        },
        status: { warning: 'var(--status-warning)', critical: 'var(--status-critical)' },
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
      // Motion (see docs/frontend.md). The built-in curves are too weak: `ease-out` here is a strong
      // ease-out for things entering or responding, `ease-in-out` for things moving on screen.
      // There is deliberately no ease-in: it makes UI feel sluggish.
      transitionTimingFunction: {
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        'in-out': 'cubic-bezier(0.77, 0, 0.175, 1)',
      },
      keyframes: {
        enter: { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
        fade: { from: { opacity: '0' }, to: { opacity: '1' } },
        pulse_dot: { '0%, 80%, 100%': { opacity: '0.25' }, '40%': { opacity: '1' } },
      },
      animation: {
        // New items arriving (an answer, a message, a card). Reduced motion swaps it for a fade.
        enter: 'enter 220ms cubic-bezier(0.23, 1, 0.32, 1) both',
        fade: 'fade 200ms ease both',
        'pulse-dot': 'pulse_dot 1.1s linear infinite',
      },
    },
  },
};
