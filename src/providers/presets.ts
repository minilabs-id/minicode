// Gateway presets — dikosongkan agar pengguna langsung mengisi Base URL dan API key
// saat menambah provider tanpa memilih provider terdaftar terlebih dahulu.

export interface GatewayPreset {
  id: string
  label: string
  baseUrl: string
  fallbackModels: string[]
  hint?: string
}

export const GATEWAY_PRESETS: GatewayPreset[] = []

// id preset → opsi "custom" di ujung daftar
export const CUSTOM_PRESET_ID = "custom"

export function findPreset(id: string): GatewayPreset | undefined {
  return GATEWAY_PRESETS.find((p) => p.id === id)
}
