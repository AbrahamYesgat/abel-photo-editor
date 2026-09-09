// ABEL — Presets (realistic, no neon colors)
const PRESETS = [
    {
        name: 'Natural',
        icon: '🌿',
        adjustments: {
            exposure: 0.1, contrast: 5, highlights: -10, shadows: 15,
            temperature: 3, vibrance: 10, clarity: 5
        }
    },
    {
        name: 'Vivid',
        icon: '🎨',
        adjustments: {
            exposure: 0.1, contrast: 15, highlights: -15, shadows: 10,
            vibrance: 25, saturation: 10, clarity: 10
        }
    },
    {
        name: 'Warm Sunset',
        icon: '🌅',
        adjustments: {
            exposure: 0.1, contrast: 8, highlights: -20, shadows: 20,
            temperature: 20, tint: 3, vibrance: 15, saturation: 5,
            vignetteAmount: 15, vignetteMidpoint: 50
        }
    },
    {
        name: 'Cool Blue',
        icon: '❄️',
        adjustments: {
            contrast: 8, temperature: -15, tint: -3,
            vibrance: 10, highlights: -10, shadows: 10
        }
    },
    {
        name: 'Film Noir',
        icon: '🎬',
        adjustments: {
            saturation: -100, contrast: 30, highlights: -15,
            shadows: -10, blacks: -15, whites: 10, clarity: 20,
            vignetteAmount: 30, vignetteMidpoint: 45, grainAmount: 15
        }
    },
    {
        name: 'Vintage',
        icon: '📷',
        adjustments: {
            exposure: 0.05, contrast: -8, highlights: -10, shadows: 20,
            temperature: 10, vibrance: -15, saturation: -10,
            grainAmount: 18, vignetteAmount: 15
        }
    },
    {
        name: 'Moody',
        icon: '🌑',
        adjustments: {
            exposure: -0.2, contrast: 18, highlights: -25, shadows: -10,
            blacks: -10, temperature: -5, vibrance: 5, clarity: 15,
            dehaze: 10, vignetteAmount: 25
        }
    },
    {
        name: 'Bright & Airy',
        icon: '☀️',
        adjustments: {
            exposure: 0.35, contrast: -10, highlights: -5, shadows: 35,
            whites: 15, temperature: 5, vibrance: 8
        }
    },
    {
        name: 'Cinematic',
        icon: '🎥',
        adjustments: {
            exposure: -0.1, contrast: 12, highlights: -20, shadows: 8,
            temperature: -5, tint: 3, saturation: -8,
            clarity: 8, vignetteAmount: 20, vignetteMidpoint: 55
        }
    },
    {
        name: 'Faded',
        icon: '🌫️',
        adjustments: {
            contrast: -15, highlights: -8, shadows: 25, blacks: 20,
            vibrance: -10, saturation: -12, temperature: 3
        }
    },
    {
        name: 'HDR',
        icon: '🏔️',
        adjustments: {
            contrast: 8, highlights: -45, shadows: 45, whites: 10,
            blacks: -8, clarity: 30, vibrance: 15, dehaze: 12
        }
    },
    {
        name: 'Sepia',
        icon: '🟤',
        adjustments: {
            saturation: -70, temperature: 20, tint: 5,
            contrast: 5, grainAmount: 10, vignetteAmount: 15
        }
    },
    {
        name: 'Matte',
        icon: '🖼️',
        adjustments: {
            contrast: -5, blacks: 25, shadows: 12, highlights: -8,
            saturation: -8, vibrance: -5
        }
    },
    {
        name: 'Punchy',
        icon: '💥',
        adjustments: {
            exposure: 0.1, contrast: 20, highlights: -15, shadows: 12,
            clarity: 20, vibrance: 18, saturation: 5, dehaze: 8
        }
    },
    {
        name: 'Golden Hour',
        icon: '🌤️',
        adjustments: {
            exposure: 0.15, temperature: 15, tint: 5, highlights: -12,
            shadows: 15, vibrance: 12, saturation: 5, clarity: 5,
            vignetteAmount: 10
        }
    },
];
