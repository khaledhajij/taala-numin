/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Readex Pro"', 'system-ui', 'sans-serif'],
        serif: ['"Amiri"', 'serif'],
      },
      colors: {
        cream: {
          50: '#FAF7F0',
          100: '#F3EDE0',
          200: '#E6DEC8',
        },
        emeraldDeep: {
          700: '#1B5E45',
          800: '#144734',
          900: '#0D3123',
        },
        goldAccent: {
          400: '#D4AF37',
          500: '#B8922A',
          600: '#94721B',
        },
      },
    },
  },
  plugins: [],
};
