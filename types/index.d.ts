export type Change = { kind: 'added' | 'modified' | 'deleted'; at: number }
export type ViewKey = 'size' | 'age' | 'tags' | 'legend' | 'ignored' | 'dotfiles' | 'guides' | 'autoOpen' | 'recentFirst'

declare module 'claude-code' {
  interface PluginState {
    'live-files': {
      cwd: string
      root: string
      browse: string
      expanded: string[]
      changes: Record<string, Change>
      selected: string
      changedOnly: boolean
      showFull: boolean
      version: number
      notice: string
      isClosed: boolean
      isPicking: boolean
      touched: Record<string, Change>
      blink: boolean
      view: Record<ViewKey, boolean>
      isMenuOpen: boolean
      collapsed: string[]
      isPaused: boolean
    }
  }
}
