import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import { SidebarContext } from '../context/SidebarContext';
const CATEGORIES = [
  { key: 'all', label: 'All', color: colors.gray500 },
  { key: 'general', label: 'General', color: '#6b7280' },
  { key: 'api-docs', label: 'API Docs', color: '#3b82f6' },
  { key: 'architecture', label: 'Architecture', color: '#8b5cf6' },
  { key: 'conventions', label: 'Conventions', color: '#f59e0b' },
  { key: 'test-patterns', label: 'Tests', color: '#10b981' },
  { key: 'troubleshooting', label: 'Troubleshooting', color: '#ef4444' },
  { key: 'onboarding', label: 'Onboarding', color: '#14b8a6' },
];
const mdStyles = {
  body: { color: colors.gray200, fontSize: 14 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  code_inline: {
    backgroundColor: colors.gray800,
    color: colors.emerald400,
    paddingHorizontal: 4,
    borderRadius: 3,
    fontSize: 13,
  },
  fence: {
    backgroundColor: colors.gray800,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  code_block: { color: colors.gray200, fontSize: 13 },
  link: { color: colors.blue600, textDecorationLine: 'none' },
  heading1: { color: colors.white, fontSize: 22, fontWeight: 'bold', marginBottom: 8 },
  heading2: { color: colors.white, fontSize: 18, fontWeight: 'bold', marginBottom: 6 },
  heading3: { color: colors.white, fontSize: 16, fontWeight: '600', marginBottom: 4 },
  bullet_list: { marginBottom: 8 },
  ordered_list: { marginBottom: 8 },
  list_item: { marginBottom: 2 },
  blockquote: {
    backgroundColor: colors.gray800,
    borderLeftColor: colors.gray600,
    borderLeftWidth: 3,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginVertical: 8,
  },
  strong: { color: colors.white, fontWeight: 'bold' },
  em: { color: colors.gray300, fontStyle: 'italic' },
  hr: { backgroundColor: colors.gray700, height: 1, marginVertical: 16 },
};
function CategoryBadge({ category }: any) {
  const cat = CATEGORIES.find((c: any) => c.key === category) || CATEGORIES[1];
  return (
    <View style={[styles.badge, { backgroundColor: cat.color + '22' }]}>
      <Text style={[styles.badgeText, { color: cat.color }]}>{cat.label}</Text>
    </View>
  );
}
export default function WikiScreen({ route }: any) {
  const { projects } = useApp();
  const { openSidebar } = React.useContext(SidebarContext);
  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = projects?.find((p: any) => p.id === projectId);
  const [pages, setPages] = useState<any[]>([]);
  const [selectedPage, setSelectedPage] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [loading, setLoading] = useState(false);
  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('general');
  const searchTimeout = useRef<any>(null);
  const loadPages = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      let data;
      if (searchQuery.trim()) {
        data = await api.searchWiki(projectId, searchQuery);
      } else if (activeCategory !== 'all') {
        data = await api.getWikiPagesByCategory(projectId, activeCategory);
      } else {
        data = await api.getWikiPages(projectId);
      }
      setPages(data || []);
    } catch (err: any) {
      console.warn('Failed to load wiki pages:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, searchQuery, activeCategory]);
  useEffect(() => {
    loadPages();
  }, [loadPages]);
  const handleSearch = (text: any) => {
    setSearchQuery(text);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      // loadPages will be triggered by the searchQuery state change
    }, 400);
  };
  const handleSelectPage = async (page: any) => {
    try {
      const full = await api.getWikiPage(projectId, page.slug);
      setSelectedPage(full);
      setEditing(false);
      setCreating(false);
    } catch (err: any) {
      Alert.alert('Error', 'Failed to load page');
    }
  };
  const handleEdit = () => {
    if (!selectedPage) return;
    setEditTitle(selectedPage.title);
    setEditContent(selectedPage.content || '');
    setEditCategory(selectedPage.category || 'general');
    setEditing(true);
    setCreating(false);
  };
  const handleCreate = () => {
    setEditTitle('');
    setEditContent('');
    setEditCategory('general');
    setCreating(true);
    setEditing(false);
    setSelectedPage(null);
  };
  const handleSave = async () => {
    if (!editTitle.trim()) {
      Alert.alert('Error', 'Title is required');
      return;
    }
    try {
      if (creating) {
        const page = await api.createWikiPage(projectId, {
          title: editTitle.trim(),
          content: editContent,
          category: editCategory,
        });
        setSelectedPage({ ...page });
        setCreating(false);
      } else if (editing && selectedPage) {
        const page = await api.updateWikiPage(projectId, selectedPage.slug, {
          title: editTitle.trim(),
          content: editContent,
          category: editCategory,
        });
        setSelectedPage({ ...page });
        setEditing(false);
      }
      loadPages();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to save');
    }
  };
  const handleDelete = (page: any) => {
    Alert.alert('Delete Page', `Delete "${page.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteWikiPage(projectId, page.slug);
            if (selectedPage?.slug === page.slug) {
              setSelectedPage(null);
              setEditing(false);
            }
            loadPages();
          } catch (err: any) {
            Alert.alert('Error', 'Failed to delete');
          }
        },
      },
    ]);
  };
  const handleCancel = () => {
    setEditing(false);
    setCreating(false);
  };
  // Page list view
  if (!selectedPage && !creating) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
            <Text style={styles.menuIcon}>{'\u2630'}</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Wiki</Text>
          {project && (
            <Text style={styles.projectLabel} numberOfLines={1}>
              {project.name}
            </Text>
          )}
          <TouchableOpacity onPress={handleCreate} style={styles.addButton}>
            <Text style={styles.addButtonText}>+</Text>
          </TouchableOpacity>
        </View>

        {/* Search */}
        <View style={styles.searchContainer}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search wiki..."
            placeholderTextColor={colors.gray600}
            value={searchQuery}
            onChangeText={handleSearch}
          />
        </View>

        {/* Category filters */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.categoryBar}
          contentContainerStyle={styles.categoryContent}
        >
          {CATEGORIES.map((cat: any) => (
            <TouchableOpacity
              key={cat.key}
              style={[
                styles.categoryChip,
                activeCategory === cat.key && { backgroundColor: cat.color + '33' },
              ]}
              onPress={() => setActiveCategory(cat.key)}
            >
              <View style={[styles.categoryDot, { backgroundColor: cat.color }]} />
              <Text
                style={[
                  styles.categoryChipText,
                  activeCategory === cat.key && { color: colors.white },
                ]}
              >
                {cat.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Page list */}
        {pages.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No wiki pages yet</Text>
            <Text style={styles.emptyDesc}>
              Create pages to build a shared knowledge base for your agents. Agents can search and
              update the wiki as they work.
            </Text>
            <TouchableOpacity style={styles.emptyButton} onPress={handleCreate}>
              <Text style={styles.emptyButtonText}>Create First Page</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={pages}
            keyExtractor={(item: any) => item.id || item.slug}
            renderItem={({ item }: any) => (
              <TouchableOpacity
                style={styles.pageItem}
                onPress={() => handleSelectPage(item)}
                onLongPress={() => handleDelete(item)}
              >
                <View style={styles.pageItemHeader}>
                  <Text style={styles.pageTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <CategoryBadge category={item.category} />
                </View>
                {item.snippet && (
                  <Text style={styles.pageSnippet} numberOfLines={2}>
                    {item.snippet.replace(/<\/?mark>/g, '')}
                  </Text>
                )}
                <View style={styles.pageItemFooter}>
                  <Text style={styles.pageMeta}>{item.updated_by || 'user'}</Text>
                  <Text style={styles.pageMeta}>{relativeTime(item.updated_at)}</Text>
                </View>
              </TouchableOpacity>
            )}
            contentContainerStyle={{ padding: 12 }}
          />
        )}
      </SafeAreaView>
    );
  }
  // Detail/edit view
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => {
            setSelectedPage(null);
            setEditing(false);
            setCreating(false);
          }}
          style={styles.menuButton}
        >
          <Text style={styles.backIcon}>{'\u2190'}</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {creating ? 'New Page' : selectedPage?.title || 'Page'}
        </Text>
        <View style={{ flex: 1 }} />
        {!editing && !creating && selectedPage && (
          <>
            <TouchableOpacity onPress={handleEdit} style={styles.headerAction}>
              <Text style={styles.headerActionText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleDelete(selectedPage)}
              style={styles.headerAction}
            >
              <Text style={[styles.headerActionText, { color: '#ef4444' }]}>Delete</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {editing || creating ? (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <ScrollView style={styles.editContainer} keyboardShouldPersistTaps="handled">
            {/* Title */}
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput
              style={styles.fieldInput}
              value={editTitle}
              onChangeText={setEditTitle}
              placeholder="Page title"
              placeholderTextColor={colors.gray600}
            />

            {/* Category */}
            <Text style={styles.fieldLabel}>Category</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginBottom: 16 }}
            >
              {CATEGORIES.filter((c: any) => c.key !== 'all').map((cat: any) => (
                <TouchableOpacity
                  key={cat.key}
                  style={[
                    styles.categoryChip,
                    editCategory === cat.key && { backgroundColor: cat.color + '33' },
                    { marginRight: 8 },
                  ]}
                  onPress={() => setEditCategory(cat.key)}
                >
                  <View style={[styles.categoryDot, { backgroundColor: cat.color }]} />
                  <Text
                    style={[
                      styles.categoryChipText,
                      editCategory === cat.key && { color: colors.white },
                    ]}
                  >
                    {cat.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* Content */}
            <Text style={styles.fieldLabel}>Content (Markdown)</Text>
            <TextInput
              style={styles.contentInput}
              value={editContent}
              onChangeText={setEditContent}
              placeholder="Write your wiki page in markdown..."
              placeholderTextColor={colors.gray600}
              multiline
              textAlignVertical="top"
            />

            {/* Actions */}
            <View style={styles.editActions}>
              <TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
                <Text style={styles.saveButtonText}>Save</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <ScrollView style={styles.viewContainer}>
          {/* Page header */}
          <View style={styles.pageHeader}>
            <Text style={styles.pageViewTitle}>{selectedPage?.title}</Text>
            <View style={styles.pageHeaderMeta}>
              <CategoryBadge category={selectedPage?.category} />
              <Text style={styles.pageMeta}>
                by {selectedPage?.updated_by || 'user'} {relativeTime(selectedPage?.updated_at)}
              </Text>
            </View>
          </View>

          {/* Content */}
          <View style={styles.markdownContainer}>
            <Markdown style={mdStyles as any}>
              {selectedPage?.content || '*No content yet*'}
            </Markdown>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.gray950,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 8,
  },
  menuButton: {
    padding: 4,
  },
  menuIcon: {
    fontSize: 22,
    color: colors.gray400,
  },
  backIcon: {
    fontSize: 22,
    color: colors.gray400,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.white,
  },
  projectLabel: {
    fontSize: 12,
    color: colors.gray500,
    maxWidth: 100,
  },
  addButton: {
    marginLeft: 'auto',
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: colors.gray800,
    borderRadius: 6,
  },
  addButtonText: {
    fontSize: 18,
    color: colors.gray300,
    fontWeight: '600',
  },
  headerAction: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  headerActionText: {
    fontSize: 14,
    color: colors.blue600,
    fontWeight: '500',
  },
  searchContainer: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.white,
  },
  categoryBar: {
    maxHeight: 44,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  categoryContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: colors.gray800,
    gap: 5,
    marginRight: 4,
  },
  categoryDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  categoryChipText: {
    fontSize: 12,
    color: colors.gray400,
    fontWeight: '500',
  },
  pageItem: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  pageItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  pageTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.white,
    flex: 1,
    marginRight: 8,
  },
  pageSnippet: {
    fontSize: 12,
    color: colors.gray500,
    marginBottom: 6,
  },
  pageItemFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  pageMeta: {
    fontSize: 11,
    color: colors.gray600,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.gray400,
    marginBottom: 8,
  },
  emptyDesc: {
    fontSize: 14,
    color: colors.gray600,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  emptyButton: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  emptyButtonText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  // Detail view
  viewContainer: {
    flex: 1,
    padding: 16,
  },
  pageHeader: {
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  pageViewTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.white,
    marginBottom: 8,
  },
  pageHeaderMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  markdownContainer: {
    paddingBottom: 40,
  },
  // Edit view
  editContainer: {
    flex: 1,
    padding: 16,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.gray500,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldInput: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.white,
    marginBottom: 16,
  },
  contentInput: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.white,
    minHeight: 200,
    marginBottom: 16,
  },
  editActions: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 40,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: colors.gray800,
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray400,
  },
  saveButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: colors.blue600,
    alignItems: 'center',
  },
  saveButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.white,
  },
});
