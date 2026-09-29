// Localized strings for the Graphics settings section. The rest of the game
// ships in English; this panel follows the browser language.

const EN = {
  quality: 'Quality', auto: 'Auto (detected: {tier})', scale: 'Render scale',
  fromPreset: 'From preset ({tier})', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device; rendering without it.',
  cats: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade',
    antialias: 'Anti-aliasing', reflections: 'Reflections', detail: 'Surface detail',
    particles: 'Particles', background: 'Sky motion',
  },
  tiers: {
    low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra', off: 'Off', on: 'On',
    medium: 'Medium', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Plain', detailed: 'Detailed',
    static: 'Still', animated: 'Animated',
  },
};

const STRINGS = {
  'en-US': EN,
  'en-GB': { ...EN, cats: { ...EN.cats, grade: 'Colour grade' } },
  'es-419': {
    quality: 'Calidad', auto: 'Automática (detectada: {tier})', scale: 'Escala de renderizado',
    fromPreset: 'Según el ajuste ({tier})', adaptive: 'Resolución adaptable', showFps: 'Mostrar fotogramas por segundo',
    postFailed: 'El posprocesamiento no está disponible en este dispositivo; se renderiza sin él.',
    cats: {
      shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
      antialias: 'Antialiasing', reflections: 'Reflejos', detail: 'Detalle de superficies',
      particles: 'Partículas', background: 'Movimiento del cielo',
    },
    tiers: {
      low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', off: 'No', on: 'Sí',
      medium: 'Media', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Detallado',
      static: 'Quieto', animated: 'Animado',
    },
  },
  'es-ES': {
    quality: 'Calidad', auto: 'Automática (detectada: {tier})', scale: 'Escala de renderizado',
    fromPreset: 'Según el preajuste ({tier})', adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
    postFailed: 'El posprocesado no está disponible en este dispositivo; se renderiza sin él.',
    cats: {
      shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Etalonaje de color',
      antialias: 'Antialiasing', reflections: 'Reflejos', detail: 'Detalle de superficies',
      particles: 'Partículas', background: 'Movimiento del cielo',
    },
    tiers: {
      low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', off: 'No', on: 'Sí',
      medium: 'Media', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Sencillo', detailed: 'Detallado',
      static: 'Quieto', animated: 'Animado',
    },
  },
  'de-DE': {
    quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', scale: 'Renderskalierung',
    fromPreset: 'Laut Voreinstellung ({tier})', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; es wird ohne sie gerendert.',
    cats: {
      shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur',
      antialias: 'Kantenglättung', reflections: 'Spiegelungen', detail: 'Oberflächendetails',
      particles: 'Partikel', background: 'Himmelsbewegung',
    },
    tiers: {
      low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra', off: 'Aus', on: 'An',
      medium: 'Mittel', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Schlicht', detailed: 'Detailliert',
      static: 'Still', animated: 'Animiert',
    },
  },
  'fr-FR': {
    quality: 'Qualité', auto: 'Auto (détectée : {tier})', scale: 'Échelle de rendu',
    fromPreset: 'Selon le préréglage ({tier})', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    postFailed: 'Le post-traitement est indisponible sur cet appareil ; rendu sans post-traitement.',
    cats: {
      shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs',
      antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détail des surfaces',
      particles: 'Particules', background: 'Mouvement du ciel',
    },
    tiers: {
      low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra', off: 'Désactivé', on: 'Activé',
      medium: 'Moyenne', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Détaillé',
      static: 'Fixe', animated: 'Animé',
    },
  },
  'fr-CA': {
    quality: 'Qualité', auto: 'Auto (détectée : {tier})', scale: 'Échelle de rendu',
    fromPreset: 'Selon le préréglage ({tier})', adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
    postFailed: 'Le post-traitement n’est pas offert sur cet appareil; rendu sans post-traitement.',
    cats: {
      shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Correction des couleurs',
      antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détail des surfaces',
      particles: 'Particules', background: 'Mouvement du ciel',
    },
    tiers: {
      low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra', off: 'Désactivé', on: 'Activé',
      medium: 'Moyenne', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Détaillé',
      static: 'Fixe', animated: 'Animé',
    },
  },
  'pt-BR': {
    quality: 'Qualidade', auto: 'Automática (detectada: {tier})', scale: 'Escala de renderização',
    fromPreset: 'Da predefinição ({tier})', adaptive: 'Resolução adaptável', showFps: 'Mostrar taxa de quadros',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; renderizando sem ele.',
    cats: {
      shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor',
      antialias: 'Antisserrilhamento', reflections: 'Reflexos', detail: 'Detalhe das superfícies',
      particles: 'Partículas', background: 'Movimento do céu',
    },
    tiers: {
      low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', off: 'Desligado', on: 'Ligado',
      medium: 'Média', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simples', detailed: 'Detalhado',
      static: 'Parado', animated: 'Animado',
    },
  },
  'it-IT': {
    quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', scale: 'Scala di rendering',
    fromPreset: 'Dal preset ({tier})', adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; rendering senza.',
    cats: {
      shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
      antialias: 'Antialiasing', reflections: 'Riflessi', detail: 'Dettaglio superfici',
      particles: 'Particelle', background: 'Movimento del cielo',
    },
    tiers: {
      low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra', off: 'No', on: 'Sì',
      medium: 'Media', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Semplice', detailed: 'Dettagliato',
      static: 'Fermo', animated: 'Animato',
    },
  },
};

export const GFX_LOCALES = Object.keys(STRINGS);

/** Best locale for a BCP-47 tag (e.g. navigator.language). */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = GFX_LOCALES.find(l => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.slice(0, 2).toLowerCase();
  const region = t.slice(3).toUpperCase();
  if (lang === 'en') return ['GB', 'IE', 'AU', 'NZ'].includes(region) ? 'en-GB' : 'en-US';
  if (lang === 'es') return !region || region === 'ES' ? 'es-ES' : 'es-419';
  if (lang === 'fr') return region === 'CA' ? 'fr-CA' : 'fr-FR';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

export function gfxStrings(tag) {
  return STRINGS[pickLocale(tag)];
}
