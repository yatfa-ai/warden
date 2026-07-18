// Appearance section — pure client localStorage prefs (terminal look, theme,
// window/launch behavior). Receives its pref group from App via SettingsPage
// and spreads it straight through. Owns the one piece of local state the
// appearance controls need (the custom-font Select/free-text toggle). Extracted
// verbatim from SettingsPage (WARDEN-664); behavior is unchanged.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { THEMES } from '@/lib/theme';
import { DEFAULT_TERMINAL_FONT_FAMILY } from '@/lib/storage';
import { hasWindowBridge } from '@/lib/electron';
import { TERMINAL_FONT_OPTIONS, CUSTOM_FONT_VALUE } from '../fontOptions';
import { SettingsSection } from '../SettingsSection';
import { type AppearancePrefs } from '../types';

export type AppearanceSectionProps = AppearancePrefs & { hidden: boolean };

export function AppearanceSection(props: AppearanceSectionProps) {
  const {
    terminalFontSize, setTerminalFontSize,
    terminalFontFamily, setTerminalFontFamily,
    terminalScrollback, setTerminalScrollback,
    theme, setTheme,
    terminalColorScheme, setTerminalColorScheme,
    terminalCursorStyle, setTerminalCursorStyle,
    copyOnSelect, setCopyOnSelect,
    density, setDensity,
    timestampFormat, setTimestampFormat,
    paneLayout, setPaneLayout,
    onExitBehavior, setOnExitBehavior,
    autoFocusNewPane, setAutoFocusNewPane,
    restoreOnStartup, setRestoreOnStartup,
    rememberWindowBounds, setRememberWindowBounds,
    launchAtLogin, setLaunchAtLogin,
    closeToTray, setCloseToTray,
    hidden,
  } = props;

  // Terminal font family Select: a curated font, or "Custom…" which reveals a
  // free-text input for any installed CSS font (e.g. a Nerd Font for glyphs).
  // The pref is always the full CSS font-family string; customFontMode tracks
  // whether the free-text field is shown (initialized from whether the saved
  // value is already a non-curated/custom value). A blank custom value falls
  // back to the default stack, but we stay in custom mode so the field doesn't
  // vanish mid-edit.
  const matchedCurated = TERMINAL_FONT_OPTIONS.find((f) => f.value === terminalFontFamily);
  const [customFontMode, setCustomFontMode] = useState(!matchedCurated);
  const [customFontText, setCustomFontText] = useState(!matchedCurated ? terminalFontFamily : '');
  const fontSelectValue = customFontMode ? CUSTOM_FONT_VALUE : terminalFontFamily;

  return (
    <SettingsSection title="Appearance" className={hidden ? 'hidden' : undefined}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="terminalFontSize">Terminal font size</Label>
        <Input
          id="terminalFontSize"
          type="number"
          min="8"
          max="24"
          step="1"
          value={terminalFontSize}
          onChange={(e) => setTerminalFontSize(parseInt(e.target.value, 10) || 14)}
          onBlur={(e) => {
            const n = parseInt(e.target.value, 10);
            setTerminalFontSize(Number.isNaN(n) ? 14 : Math.max(8, Math.min(24, n)));
          }}
        />
        <p className="text-xs text-muted-foreground">
          Applies to all terminal panes (8–24). Use the A− / A+ buttons on any pane to adjust the same value.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="terminalFontFamily">Terminal font family</Label>
        <Select
          value={fontSelectValue}
          onValueChange={(v) => {
            if (v === CUSTOM_FONT_VALUE) {
              setCustomFontMode(true);
              // Seed the field with the current custom value, or blank
              // when switching from a curated font (effective font
              // stays put until the user types something new).
              setCustomFontText(matchedCurated ? '' : terminalFontFamily);
            } else {
              setCustomFontMode(false);
              setCustomFontText('');
              setTerminalFontFamily(v);
            }
          }}
        >
          <SelectTrigger id="terminalFontFamily" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TERMINAL_FONT_OPTIONS.map((f) => (
              <SelectItem key={f.label} value={f.value}>{f.label}</SelectItem>
            ))}
            <SelectItem value={CUSTOM_FONT_VALUE}>Custom…</SelectItem>
          </SelectContent>
        </Select>
        {customFontMode && (
          <Input
            aria-label="Custom terminal font family"
            value={customFontText}
            onChange={(e) => {
              const v = e.target.value;
              setCustomFontText(v);
              // A blank custom value falls back to the default stack
              // (never a blank pane); we stay in custom mode so the
              // field keeps showing while editing.
              setTerminalFontFamily(v.trim() === '' ? DEFAULT_TERMINAL_FONT_FAMILY : v);
            }}
            placeholder='e.g. "Hack Nerd Font", ui-monospace, monospace'
          />
        )}
        <p className="text-xs text-muted-foreground">
          Monospace font for all agent panes. Pick a common font, or choose <strong>Custom…</strong> to paste any installed CSS font-family (e.g. a Nerd Font for glyphs). Applies live to open panes; blank reverts to the system default.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="terminalScrollback">Terminal scrollback (lines)</Label>
        <Input
          id="terminalScrollback"
          type="number"
          min="100"
          max="100000"
          step="100"
          value={terminalScrollback}
          onChange={(e) => setTerminalScrollback(parseInt(e.target.value, 10) || 10000)}
          onBlur={(e) => {
            const n = parseInt(e.target.value, 10);
            setTerminalScrollback(Number.isNaN(n) ? 10000 : Math.max(100, Math.min(100000, n)));
          }}
        />
        <p className="text-xs text-muted-foreground">
          Maximum lines each terminal pane keeps in memory (100–100000). Applies to new panes; existing panes pick up the change when reopened. Default 10000.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="theme">Theme</Label>
        <Select value={theme} onValueChange={(v) => setTheme(v as typeof theme)}>
          <SelectTrigger id="theme" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">System (follow OS)</SelectItem>
            <SelectGroup>
              <SelectLabel>Light</SelectLabel>
              {THEMES.filter((t) => t.mode === 'light').map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
              ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Dark</SelectLabel>
              {THEMES.filter((t) => t.mode === 'dark').map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          A complete color theme for the whole app and every terminal pane. "System" follows your OS (GitHub Light ↔ GitHub Dark); any named theme applies live and is remembered across reloads.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="terminalColorScheme">Terminal color scheme</Label>
        <Select value={terminalColorScheme} onValueChange={(v) => setTerminalColorScheme(v as typeof terminalColorScheme)}>
          <SelectTrigger id="terminalColorScheme" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Match app theme (default)</SelectItem>
            <SelectItem value="dark">Always dark</SelectItem>
            <SelectItem value="light">Always light</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          How terminal panes are colored. "Match app theme" follows the Theme above (including System); "Always dark/light" forces the terminal to GitHub Dark / GitHub Light regardless of the rest of the UI. Applies live to open panes.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="terminalCursorStyle">Terminal cursor style</Label>
        <Select value={terminalCursorStyle} onValueChange={(v) => setTerminalCursorStyle(v as typeof terminalCursorStyle)}>
          <SelectTrigger id="terminalCursorStyle" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="blink-block">Blinking block (default)</SelectItem>
            <SelectItem value="steady-block">Steady block</SelectItem>
            <SelectItem value="blink-underline">Blinking underline</SelectItem>
            <SelectItem value="steady-underline">Steady underline</SelectItem>
            <SelectItem value="blink-bar">Blinking bar</SelectItem>
            <SelectItem value="steady-bar">Steady bar</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Cursor shape and whether it blinks in terminal panes. "Steady" options stop the blink — useful if you reduce motion at the OS level (WARDEN-190 only covered page motion, not this cursor). Applies live to all open panes.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch
            id="copyOnSelect"
            checked={copyOnSelect}
            onCheckedChange={setCopyOnSelect}
          />
          <Label htmlFor="copyOnSelect" className="cursor-pointer">
            Copy on select
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          Copy agent output to the clipboard as soon as you select it (off by default). Mirrors select-to-copy in iTerm2/GNOME-Terminal/Windows Terminal — no Ctrl/Cmd+C needed. Applies live to all open panes.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="density">Density</Label>
        <Select value={density} onValueChange={(v) => setDensity(v as typeof density)}>
          <SelectTrigger id="density" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="comfortable">Comfortable (default)</SelectItem>
            <SelectItem value="compact">Compact</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          "Compact" tightens row and header spacing so more agents fit on screen. Applies instantly and is remembered across reloads.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="timestampFormat">Timestamp format</Label>
        <Select value={timestampFormat} onValueChange={(v) => setTimestampFormat(v as typeof timestampFormat)}>
          <SelectTrigger id="timestampFormat" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="relative">Relative (default)</SelectItem>
            <SelectItem value="absolute">Absolute</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          How times read across the dashboard. "Relative" shows compact buckets like "2m ago"; "Absolute" shows clock time like "2:13 PM". Applies instantly to every timestamp and is remembered across reloads.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="paneLayout">Pane layout</Label>
        <Select value={paneLayout} onValueChange={(v) => setPaneLayout(v as typeof paneLayout)}>
          <SelectTrigger id="paneLayout" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto grid (default)</SelectItem>
            <SelectItem value="stacked">Stacked (single column)</SelectItem>
            <SelectItem value="side-by-side">Side-by-side (single row)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Controls how open agent panes are arranged. "Auto grid" splits them into a near-square grid, "Stacked" stacks them in one full-width column, and "Side-by-side" lays them out in a single row. Applies instantly and is remembered across reloads.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="onExitBehavior">When an agent exits</Label>
        <Select value={onExitBehavior} onValueChange={(v) => setOnExitBehavior(v as typeof onExitBehavior)}>
          <SelectTrigger id="onExitBehavior" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="keep">Keep pane (default)</SelectItem>
            <SelectItem value="dim">Dim pane</SelectItem>
            <SelectItem value="auto-close">Auto-close pane</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          What happens to an already-open pane when its agent process exits. "Keep pane" leaves it for you to close manually; "Dim pane" marks it exited while keeping the last output readable; "Auto-close pane" removes it for you. Applies only to panes whose agent was running — a pane that never started is left alone. Applies globally and is remembered across reloads.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch
            id="autoFocusNewPane"
            checked={autoFocusNewPane}
            onCheckedChange={(v) => setAutoFocusNewPane(v)}
          />
          <Label htmlFor="autoFocusNewPane" className="cursor-pointer">
            Auto-focus pane on open
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          When on, opening, resuming, or splitting a chat moves keyboard focus to the new pane. Turn off to keep typing where you are — click any pane to focus it instead. Applies globally and is remembered across reloads.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="restoreOnStartup">Restore workspace on startup</Label>
        <Select
          value={restoreOnStartup}
          onValueChange={(v) => setRestoreOnStartup(v as typeof restoreOnStartup)}
        >
          <SelectTrigger id="restoreOnStartup" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="previous">Reopen previous (default)</SelectItem>
            <SelectItem value="empty">Start empty</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Reopen the tabs and panes you had open at last close, or start every launch with a clean workspace.
        </p>
      </div>

      {/* Remember window bounds — main-owned via IPC (WARDEN-263). Sits
          beside the sibling "Restore workspace on startup" control: both
          govern what a fresh launch looks like (contents vs. container).
          Disabled with a hint when the preload bridge is absent (browser
          / smoke test) — the same web bundle runs in all contexts. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch
            id="rememberWindowBounds"
            checked={rememberWindowBounds}
            onCheckedChange={(v) => setRememberWindowBounds(v)}
            disabled={!hasWindowBridge()}
          />
          <Label htmlFor="rememberWindowBounds" className="cursor-pointer">
            Remember window position and size
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {hasWindowBridge()
            ? 'Reopen the window at the same size, position, and maximize state as last time. Turn off to always start at the default size.'
            : 'Reopen the window at the same size, position, and maximize state as last time. Applies to the desktop app only.'}
        </p>
      </div>

      {/* Launch Warden at login — main-owned via IPC (WARDEN-278). Sits
          beside the remember-bounds control: both govern launch
          behavior. Off by default (consent — auto-start modifies the
          OS login items). Same hasWindowBridge() gating as
          remember-bounds so dev/smoke are unaffected. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch
            id="launchAtLogin"
            checked={launchAtLogin}
            onCheckedChange={(v) => setLaunchAtLogin(v)}
            disabled={!hasWindowBridge()}
          />
          <Label htmlFor="launchAtLogin" className="cursor-pointer">
            Launch Warden at login
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {hasWindowBridge()
            ? 'Open Warden automatically when you log in to your computer. Off by default — turn it on to skip relaunching Warden after every reboot.'
            : 'Open Warden automatically when you log in to your computer. Applies to the desktop app only.'}
        </p>
      </div>

      {/* Close to tray — main-owned via IPC (WARDEN-330). Sits beside
          the launch-at-login control: both govern close/launch
          behavior. Off by default (opt-in — changing what the close
          button does is surprising). When ON, the backend and desktop
          attention alerts keep running while the window is hidden, so
          it pairs naturally with launch-at-login + desktop alerts.
          Same hasWindowBridge() gating as the sibling controls. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch
            id="closeToTray"
            checked={closeToTray}
            onCheckedChange={(v) => setCloseToTray(v)}
            disabled={!hasWindowBridge()}
          />
          <Label htmlFor="closeToTray" className="cursor-pointer">
            Close to tray
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {hasWindowBridge()
            ? 'Keep Warden running in the system tray when you close the window — the backend and desktop alerts stay active. Click the tray icon to show the window, or use its menu to quit.'
            : 'Keep Warden running in the system tray when you close the window. Applies to the desktop app only.'}
        </p>
      </div>
    </SettingsSection>
  );
}
