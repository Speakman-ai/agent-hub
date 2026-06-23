// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
vi.mock('lucide-react-native', () => {
    const stub = () => null;
    return {
        AlertCircle: stub,
        ArrowUpCircle: stub,
        Bug: stub,
        Check: stub,
        CheckCircle: stub,
        ChevronDown: stub,
        ChevronRight: stub,
        Circle: stub,
        Clock: stub,
        CloudUpload: stub,
        Eye: stub,
        FileText: stub,
        FlaskConical: stub,
        GitBranch: stub,
        GitCompare: stub,
        GitMerge: stub,
        GitPullRequest: stub,
        HelpCircle: stub,
        Info: stub,
        Loader2: stub,
        Menu: stub,
        MessageCircle: stub,
        Mic: stub,
        MinusCircle: stub,
        Paperclip: stub,
        PlayCircle: stub,
        Redo2: stub,
        ScanEye: stub,
        Send: stub,
        Square: stub,
        Ticket: stub,
        Video: stub,
        Wrench: stub,
        X: stub,
        XCircle: stub,
        Zap: stub,
        Palette: stub,
        FolderOpen: stub,
        ExternalLink: stub,
    };
});
import { APP_LUCIDE_ICONS, resolveAppLucideIcon } from './appIconLucide';
/** Ionicons names referenced by mobile UI (grep AppIcon name= / SessionStateIcon). */
const USED_ICON_NAMES = [
    'menu',
    'chevron-down',
    'chevron-forward',
    'arrow-redo-outline',
    'document-text-outline',
    'close',
    'send',
    'git-branch-outline',
    'flash',
    'videocam',
    'document-outline',
    'close-circle',
    'help-circle-outline',
    'alert-circle-outline',
    'alert-circle',
    'checkmark',
    'information-circle-outline',
    'information-circle',
    'git-pull-request-outline',
    'git-pull-request',
    'chatbubbles-outline',
    'construct-outline',
    'checkmark-circle',
    'remove-circle-outline',
    'ellipse-outline',
    'git-compare-outline',
    'flask-outline',
    'cloud-upload-outline',
    'bug-outline',
    'play-circle',
    'attach',
    'mic-outline',
    'stop',
    'chatbubble-ellipses-outline',
    'sync-outline',
    'eye-outline',
    'time-outline',
    'arrow-up-circle-outline',
    'git-merge-outline',
    'pricetag-outline',
    'ticket-outline',
    'chatbubble-outline',
    'color-palette-outline',
    'folder-open-outline',
    'open-outline',
];
describe('resolveAppLucideIcon', () => {
    it('maps every icon name used in the mobile app', () => {
        for (const name of USED_ICON_NAMES) {
            expect(resolveAppLucideIcon(name), `missing mapping for ${name}`).not.toBeNull();
        }
    });
    it('exports a component for each mapped name', () => {
        for (const name of Object.keys(APP_LUCIDE_ICONS)) {
            expect(typeof APP_LUCIDE_ICONS[name]).toBe('function');
        }
    });
});
