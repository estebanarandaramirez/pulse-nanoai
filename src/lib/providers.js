/**
 * Provider feature flags.
 *
 * Set `enabled: true` to activate a provider across the entire UI and backend.
 * Disabled providers are preserved in the codebase but hidden from users.
 *
 * To re-enable a provider: flip its `enabled` flag and add its API key env var
 * to the Base44 project settings.
 */

export const PROVIDERS = {
  salad: {
    label: 'Salad',
    color: 'text-cyan',
    borderColor: 'border-cyan/30',
    bgColor: 'bg-cyan/10',
    hex: '#00e5ff',
    enabled: true,
    envVar: 'SALAD_API_KEY',
  },
  vastai: {
    label: 'Vast.ai',
    color: 'text-cyan',
    borderColor: 'border-cyan/30',
    bgColor: 'bg-cyan/10',
    hex: '#00e5ff',
    enabled: false,
    envVar: 'VASTAI_API_KEY',
  },
  runpod: {
    label: 'RunPod',
    color: 'text-amber',
    borderColor: 'border-amber/30',
    bgColor: 'bg-amber/10',
    hex: '#ffaa00',
    enabled: false,
    envVar: 'RUNPOD_API_KEY',
  },
  cloreai: {
    label: 'Clore.ai',
    color: 'text-neon-green',
    borderColor: 'border-neon-green/30',
    bgColor: 'bg-neon-green/10',
    hex: '#39ff14',
    enabled: false,
    envVar: 'CLOREAI_API_KEY',
  },
  octaspace: {
    label: 'OctaSpace',
    color: 'text-purple',
    borderColor: 'border-purple/30',
    bgColor: 'bg-purple/10',
    hex: '#8844ff',
    enabled: false,
    envVar: 'OCTASPACE_API_KEY',
  },
};

/** All providers that are currently active */
export const ENABLED_PROVIDERS = Object.entries(PROVIDERS)
  .filter(([, p]) => p.enabled)
  .map(([key, p]) => ({ key, ...p }));

/** Quick lookup: is a given provider key active? */
export const isProviderEnabled = (key) => PROVIDERS[key]?.enabled === true;
