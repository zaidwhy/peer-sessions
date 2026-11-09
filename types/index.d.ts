// What the band above the prompt shows, kept in session state so a write redraws it.

export type BandPeer = { id: string; intent: string; branch: string | null }

export type BandMessage = { from: string; text: string; at: number }

export type BandView = {
  inCheckout: BandPeer[]
  message: BandMessage | null
  // The person pressed Dismiss at this time; anything older stays hidden.
  dismissedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    // Shaped: the atom carries a shape tag, so a value an older version stored is declined.
    'peer-sessions': { band: Shaped<BandView> }
  }
}
