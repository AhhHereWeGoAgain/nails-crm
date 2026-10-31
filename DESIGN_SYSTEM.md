# Nails CRM — Studio Desk design system

Source concepts: [Anthropic Frontend Design](https://github.com/anthropics/skills/tree/main/skills/frontend-design), [UI/UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill). Guidelines were reviewed and adapted; this is an independent visual system, not a direct copy of Bitrix24.

## Intent
Single-worker nail service CRM. Daily scheduling and quick deal entry first; finance and customers second. Interface language: clear Russian action verbs, no decorative icons replacing text.

## Color tokens
- `--sidebar: #172e47` — calm navigation
- `--canvas: #f5f7fa` — neutral work canvas
- `--surface: #ffffff` — edit/list surfaces
- `--ink: #1e3044` — readable text
- `--accent: #1263cd` — primary action & selected date
- `--mint: #17846c` — income / success
- `--amber: #b87519` — expenses / attention

## Components
- Primary action: solid 43px button with left SVG and verb label.
- Secondary action: 43px border button with label.
- Calendar: entire day cell clickable; do not show floating `+` on hover.
- Selected day: labeled **Добавить** button anchored in header.
- Kanban: row-like **Добавить сделку** inside each column, left-aligned, without dashed plus-in-circle.
- Small icon buttons: real `button`, visible keyboard focus, 42px target.
- One consistent outline SVG icon family, local assets, offline first.

## Layout & accessibility
Responsive at 1280/850/560px; mobile bottom navigation; keyboard-visible focus; reduced-motion support; meaningful textual buttons and no dependency on hover. Test 390px viewport for horizontal overflow.
