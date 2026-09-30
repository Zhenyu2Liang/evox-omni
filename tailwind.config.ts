import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        banking: {
          deep: '#0B1F3A',
          navy: '#123A6B',
          accent: '#2563EB',
          success: '#16A34A',
          warn: '#F59E0B',
          danger: '#DC2626',
          light: '#F5F7FA',
        },
      },
      borderRadius: {
        xl: '1rem',
        '2xl': '1.25rem',
      },
    },
  },
  plugins: [],
};

export default config;
