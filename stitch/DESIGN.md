---
name: Paper Intelligence
colors:
  surface: '#fdf8f7'
  surface-dim: '#ddd9d8'
  surface-bright: '#fdf8f7'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f7f3f1'
  surface-container: '#f1edec'
  surface-container-high: '#ece7e6'
  surface-container-highest: '#e6e1e0'
  on-surface: '#1c1b1b'
  on-surface-variant: '#4d4540'
  inverse-surface: '#313030'
  inverse-on-surface: '#f4f0ee'
  outline: '#7e756f'
  outline-variant: '#cfc4bd'
  surface-tint: '#635d5a'
  primary: '#181512'
  on-primary: '#ffffff'
  primary-container: '#2d2926'
  on-primary-container: '#96908b'
  inverse-primary: '#cdc5c0'
  secondary: '#4c644b'
  on-secondary: '#ffffff'
  secondary-container: '#cbe7c7'
  on-secondary-container: '#50694f'
  tertiary: '#261000'
  on-tertiary: '#ffffff'
  tertiary-container: '#432100'
  on-tertiary-container: '#da7807'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e9e1dc'
  primary-fixed-dim: '#cdc5c0'
  on-primary-fixed: '#1e1b18'
  on-primary-fixed-variant: '#4b4642'
  secondary-fixed: '#ceeaca'
  secondary-fixed-dim: '#b3ceaf'
  on-secondary-fixed: '#0a200c'
  on-secondary-fixed-variant: '#354c35'
  tertiary-fixed: '#ffdcc3'
  tertiary-fixed-dim: '#ffb77d'
  on-tertiary-fixed: '#2f1500'
  on-tertiary-fixed-variant: '#6e3900'
  background: '#fdf8f7'
  on-background: '#1c1b1b'
  surface-variant: '#e6e1e0'
typography:
  display-lg:
    fontFamily: Newsreader
    fontSize: 48px
    fontWeight: '600'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Newsreader
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.2'
  body-md:
    fontFamily: Hanken Grotesk
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  data-mono:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.4'
    letterSpacing: 0.02em
  label-caps:
    fontFamily: Geist
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 12px
    letterSpacing: 0.08em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 8px
  container-padding: 40px
  gutter: 24px
  card-gap: 32px
---

## Brand & Style

This design system is built for high-stakes scientific simulation and technical oversight. It adopts a **Neo-skeuomorphic Paper** aesthetic that bridges the gap between traditional architectural blueprints and modern data science interfaces. The personality is authoritative, calm, and highly precise.

By utilizing "Paper" metaphors—layered surfaces, subtle tactile depth, and a warm editorial palette—the system reduces the cognitive load often associated with complex RL (Reinforcement Learning) data. It evokes a feeling of a "living document," where technical simulations are presented as high-end laboratory artifacts rather than cluttered industrial consoles.

## Colors

The palette is rooted in a warm, organic base to ensure long-form legibility and a premium feel.

*   **Foundation:** The background uses a warm cream (#F5EFE6), while cards and interactive surfaces use a brighter off-white (#FCF9F5) to create clear elevation.
*   **Accents:**
    *   **Forest Green (#2B422B):** Reserved for "Learning" states, active neural network updates, and positive performance deltas.
    *   **Amber (#D97706):** Used for "Running" states, warnings, and real-time data streaming.
*   **Typography:** A deep charcoal-brown (#2D2926) provides high contrast without the harshness of pure black, maintaining the sophisticated "ink on paper" feel.

## Typography

This system employs a high-contrast typographic pairing to distinguish between narrative/editorial content and technical/data-driven content.

*   **Serif (Newsreader):** Used for headlines and section titles. It provides a scholarly, authoritative tone that elevates the simulator from a tool to a research platform.
*   **Sans-Serif (Hanken Grotesk):** A modern, highly legible sans-serif for body text and descriptive UI elements.
*   **Monospace (Geist):** Specifically for numeric data, RL agent IDs, and control labels. This ensures that columns of numbers align perfectly and feel "calculated."

## Layout & Spacing

The layout follows a **Fixed-Fluid Hybrid** model. The main content area is capped at 1440px to ensure line lengths for technical data remain readable, while margins expand fluidly.

*   **Rhythm:** A strict 8px grid governs all internal padding and alignment.
*   **Density:** Generous white space is prioritized to allow the "paper" surfaces to breathe. 
*   **Breakpoints:** 
    *   **Desktop (1200px+):** 12-column grid, 40px margins.
    *   **Tablet (768px-1199px):** 8-column grid, 24px margins.
    *   **Mobile (<768px):** 4-column grid, 16px margins; headlines scale down to 32px for Display-LG.

## Elevation & Depth

Depth is achieved through "Neo-skeuomorphic" techniques that mimic physical layers of paper and subtle indentations.

*   **Inset Cards:** Rather than traditional shadows, simulation views use an inner shadow (`box-shadow: inset 0 2px 4px rgba(0,0,0,0.05)`) to appear as if they are recessed into the page.
*   **Soft Raised Elements:** Buttons and floating badges use a dual shadow: a soft, light-colored highlight on the top-left and a subtle, warm-tinted shadow on the bottom-right.
*   **Borders:** Fine, 1px lines in `#E6DED1` are used to define boundaries without adding visual weight, maintaining the "technical drawing" aesthetic.

## Shapes

The shape language is controlled and intentional. 

*   **Cards:** Use a `1rem` (16px) radius to feel modern and approachable.
*   **Interactive Controls:** Pill-shaped buttons (`2rem`) are used for primary actions to distinguish them from structural elements.
*   **Input Fields:** Use a softer `0.5rem` radius to match the structural cards.
*   **Micro-indicators:** Status dots and small badges are fully circular.

## Components

*   **Pill Buttons:** Should feature a subtle gradient (top-to-bottom) and a soft drop shadow. In active states, the button should appear "pressed" by swapping to an inset shadow.
*   **Inset Cards:** Used for the main simulation viewport. The background of these cards should be slightly darker than the page background to enhance the sense of depth.
*   **Status Chips:** Small, pill-shaped badges for "Learning" (Forest Green) and "Running" (Amber). They should include a 4px "breathing" status dot to signify live activity.
*   **Technical Sparklines:** Minimalist charts without axes, rendered in `primary-color` with a 1.5px stroke width, placed inside data cards to show agent reward trends.
*   **Control Steppers:** For numeric inputs (like "Demand Builder"), use crisp +/- buttons flanking a centered monospaced value, encased in a soft-depth container.
*   **Input Fields:** Ghost-style inputs with a subtle bottom border or a very faint recessed background.