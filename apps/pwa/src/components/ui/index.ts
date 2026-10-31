/** Composants partagés de l'interface (ADR-049). Voir la page de référence `/dev/composants` en développement. */
export { cx } from './cx.js';
export { Icon, type IconName } from './icons.js';
export { ICON_NAMES } from './icon-set.js';
export {
  AnchorButton,
  Button,
  IconButton,
  LinkButton,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from './Button.js';
export {
  Checkbox,
  Field,
  Input,
  Radio,
  Segmented,
  Select,
  Switch,
  Textarea,
  type ControlProps,
  type SegmentedOption,
} from './Form.js';
export {
  Avatar,
  Badge,
  Card,
  DataCell,
  DataList,
  DataRow,
  KpiTile,
  List,
  ListRow,
  Section,
  Sparkline,
  type BadgeTone,
  type Tone,
} from './Surface.js';
export { initials } from './initials.js';
export {
  Banner,
  EmptyState,
  Sheet,
  Skeleton,
  SkeletonRows,
  Spinner,
  ToastProvider,
  type BannerTone,
} from './Feedback.js';
export { useToast } from './toast-context.js';
export { ActionBar, BackLink, PageHeader, TabPanel, Tabs, type TabItem } from './Nav.js';
export { ThemeSwitcher } from './ThemeSwitcher.js';
export {
  THEME_PREFERENCES,
  initTheme,
  readThemePreference,
  resolveTheme,
  setThemePreference,
  useThemePreference,
  type ThemePreference,
} from './theme.js';
