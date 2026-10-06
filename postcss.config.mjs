// Tailwind 4 requires the @tailwindcss/postcss plugin for Next.js.
// Without this file, @import 'tailwindcss' in app/globals.css is a no-op
// and zero utility classes get generated.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
