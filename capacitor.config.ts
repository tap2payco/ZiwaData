import type { CapacitorConfig } from '@capacitor/cli';
import { BRAND } from './src/brand';

// UNTESTED: this config is included so the app can be wrapped later. No Android or iOS build was made.
// appId is a neutral placeholder. Change it before publishing anything.
const config: CapacitorConfig = {
  appId: 'org.example.fishwatch',
  appName: BRAND.name,
  webDir: 'dist',
  server: { androidScheme: 'https' },
};
export default config;
