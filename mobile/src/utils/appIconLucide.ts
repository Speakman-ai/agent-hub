/**
 * Maps Ionicons-style names (used across the mobile app) to Lucide components.
 * Native renders SVG via lucide-react-native — no font loading required (Expo Go safe).
 */
import { AlertCircle, ArrowUpCircle, Bug, Check, CheckCircle, ChevronDown, ChevronRight, Circle, CloudUpload, FileText, FlaskConical, GitBranch, GitCompare, GitMerge, GitPullRequest, HelpCircle, Info, Menu, MessageCircle, Mic, MinusCircle, Paperclip, PlayCircle, Redo2, Send, Square, Video, Wrench, X, XCircle, Zap, Eye, Clock, Loader2, ScanEye, Ticket, Palette, FolderOpen, ExternalLink, } from 'lucide-react-native';
/** @type {Record<string, React.ComponentType<{ size?: number, color?: string, strokeWidth?: number, style?: object }>>} */
export const APP_LUCIDE_ICONS: Record<string, any> = {
    menu: Menu,
    'chevron-down': ChevronDown,
    'chevron-forward': ChevronRight,
    'arrow-redo-outline': Redo2,
    close: X,
    send: Send,
    'git-branch-outline': GitBranch,
    flash: Zap,
    videocam: Video,
    'document-outline': FileText,
    'document-text-outline': FileText,
    'close-circle': XCircle,
    'help-circle-outline': HelpCircle,
    'alert-circle-outline': AlertCircle,
    'alert-circle': AlertCircle,
    checkmark: Check,
    'information-circle-outline': Info,
    'information-circle': Info,
    'git-pull-request-outline': GitPullRequest,
    'git-pull-request': GitPullRequest,
    'ticket-outline': Ticket,
    ticket: Ticket,
    'pricetag-outline': Ticket,
    'chatbubbles-outline': MessageCircle,
    'chatbubble-ellipses-outline': MessageCircle,
    'construct-outline': Wrench,
    'checkmark-circle': CheckCircle,
    'remove-circle-outline': MinusCircle,
    'ellipse-outline': Circle,
    'git-compare-outline': GitCompare,
    'flask-outline': FlaskConical,
    'cloud-upload-outline': CloudUpload,
    'bug-outline': Bug,
    'play-circle': PlayCircle,
    attach: Paperclip,
    'mic-outline': Mic,
    stop: Square,
    'sync-outline': Loader2,
    'eye-outline': Eye,
    'scan-eye': ScanEye,
    'time-outline': Clock,
    'arrow-up-circle-outline': ArrowUpCircle,
    'git-merge-outline': GitMerge,
    'chatbubble-outline': MessageCircle,
    'color-palette-outline': Palette,
    'folder-open-outline': FolderOpen,
    'open-outline': ExternalLink,
};
/**
 * @param {string} name
 * @returns {React.ComponentType<{ size?: number, color?: string, strokeWidth?: number, style?: object }> | null}
 */
export function resolveAppLucideIcon(name: any) {
    return APP_LUCIDE_ICONS[name] || null;
}
