import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';

const config = defineConfig({ plugins: [voidPlugin(), tanstackStart(), react()] });

export default config;
