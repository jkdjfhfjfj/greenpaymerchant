import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Eye, EyeOff, FileText, HelpCircle, History, LoaderCircle, Pencil, Plus, Save, Upload } from 'lucide-react';
import { Async, Btn, Err, Field, Gate, Heading, Note, Pill } from '@/components/kit';
import { usePlatformBranding } from '@/components/platform-brand';
import '@/pages/content.css';

type ContentKind = 'guide' | 'article' | 'faq';
type ContentStatus = 'draft' | 'published';
type ContentRecord = {
  id: number;
  kind: ContentKind;
  status: ContentStatus;
  title: string;
  slug: string;
  summary: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  version: number;
  updatedBy: string | null;
};
type ContentInput = Pick<ContentRecord, 'kind' | 'title' | 'slug' | 'summary' | 'body'>;
type ContentVersion = Pick<ContentRecord, 'id' | 'kind' | 'status' | 'title' | 'slug' | 'summary' | 'body' | 'version' | 'updatedAt' | 'updatedBy'> & { createdBy: string | null; createdAt: string };
type ContentListResponse = { items: ContentRecord[] };
type VersionsResponse = { items: ContentVersion[] };

const adminKey = ['greenpay-content', 'admin'];
const verifiedPublicBase = import.meta.env.VITE_PUBLIC_SITE_URL?.trim() || 'https://empty-project.replit.app';
const kindLabel: Record<ContentKind, string> = { guide: 'Guide', article: 'Article', faq: 'FAQ' };
const emptyDraft: ContentInput = { kind: 'guide', title: '', slug: '', summary: '', body: '' };

async function contentRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  const result = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = result && typeof result.error === 'string' ? result.error : `The request failed (${response.status}).`;
    throw new Error(message);
  }
  return result as T;
}

function updateBrowserMetadata(title: string, description: string, canonicalPath: string, noindex = false) {
  document.title = title;
  let descriptionTag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!descriptionTag) {
    descriptionTag = document.createElement('meta');
    descriptionTag.name = 'description';
    document.head.append(descriptionTag);
  }
  descriptionTag.content = description;
  let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (!robots) {
    robots = document.createElement('meta');
    robots.name = 'robots';
    document.head.append(robots);
  }
  robots.content = noindex ? 'noindex, nofollow' : 'index, follow';
  let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.append(canonical);
  }
  canonical.href = new URL(canonicalPath, `${verifiedPublicBase.replace(/\/$/, '')}/`).toString();
  const og = (property: string, content: string) => {
    let element = document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
    if (!element) {
      element = document.createElement('meta');
      element.setAttribute('property', property);
      document.head.append(element);
    }
    element.content = content;
  };
  og('og:title', title);
  og('og:description', description);
  og('og:url', canonical.href);
  og('og:type', noindex ? 'website' : 'article');
  const twitter = (name: string, content: string) => {
    let element = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
    if (!element) {
      element = document.createElement('meta');
      element.name = name;
      document.head.append(element);
    }
    element.content = content;
  };
  twitter('twitter:card', 'summary');
  twitter('twitter:title', title);
  twitter('twitter:description', description);
}

function routeFor(record: Pick<ContentRecord, 'kind' | 'slug'>) {
  return record.kind === 'faq' ? `/learn/${record.slug}` : `/${record.kind === 'guide' ? 'guides' : 'articles'}/${record.slug}`;
}

function useAdminContent() {
  return useQuery({
    queryKey: adminKey,
    queryFn: () => contentRequest<ContentListResponse>('/api/admin/content'),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

export function AdminContentPage() {
  return <Gate need="admin"><AdminContentEditor /></Gate>;
}

function AdminContentEditor() {
  const queryClient = useQueryClient();
  const query = useAdminContent();
  const records = query.data?.items ?? [];
  const [filterKind, setFilterKind] = useState<ContentKind | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<ContentStatus | 'all'>('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<ContentInput>(emptyDraft);
  const [editing, setEditing] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  const [versionsOpen, setVersionsOpen] = useState(false);
  const versions = useQuery({
    queryKey: [...adminKey, 'versions', selectedId],
    queryFn: () => contentRequest<VersionsResponse>(`/api/admin/content/${selectedId}/versions`),
    enabled: versionsOpen && selectedId !== null,
    staleTime: 0,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: adminKey });
  const save = useMutation({
    mutationFn: ({ id, data }: { id: number | null; data: ContentInput }) => contentRequest<ContentRecord>(
      id === null ? '/api/admin/content' : `/api/admin/content/${id}`,
      { method: id === null ? 'POST' : 'PATCH', body: JSON.stringify(data) },
    ),
    onSuccess: async (record) => {
      await invalidate();
      setSelectedId(record.id);
      setEditing(false);
      setVersionsOpen(false);
      setSavedMessage(`${kindLabel[record.kind]} saved as ${record.status}.`);
    },
  });
  const publication = useMutation({
    mutationFn: ({ record, action }: { record: ContentRecord; action: 'publish' | 'unpublish' }) => contentRequest<ContentRecord>(
      `/api/admin/content/${record.id}/${action}`,
      { method: 'POST' },
    ),
    onSuccess: async (record) => {
      await invalidate();
      setSelectedId(record.id);
      setSavedMessage(record.status === 'published' ? 'Content published.' : 'Content unpublished and removed from public pages.');
    },
  });
  const filtered = useMemo(() => records.filter((record) =>
    (filterKind === 'all' || record.kind === filterKind) &&
    (filterStatus === 'all' || record.status === filterStatus),
  ), [records, filterKind, filterStatus]);
  const current = records.find((record) => record.id === selectedId) ?? null;

  useEffect(() => {
    updateBrowserMetadata('Public content editor · Greenpay', 'Manage published Greenpay help, guides, articles and FAQs.', '/admin/content', true);
  }, []);

  function startNew() {
    setSelectedId(null);
    setDraft(emptyDraft);
    setEditing(true);
    setVersionsOpen(false);
    setSavedMessage('');
    save.reset();
    publication.reset();
  }

  function startEditing(record: ContentRecord) {
    setSelectedId(record.id);
    setDraft({ kind: record.kind, title: record.title, slug: record.slug, summary: record.summary, body: record.body });
    setEditing(true);
    setVersionsOpen(false);
    setSavedMessage('');
    save.reset();
    publication.reset();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavedMessage('');
    save.mutate({ id: selectedId, data: draft });
  }

  return <div className="content-admin" data-testid="page-admin-content">
    <Heading eyebrow="ADMIN / PUBLISHING" title="Public content" subtitle="Create and maintain public Greenpay guides, articles and FAQs. Drafts stay private until an administrator publishes them." action={<Btn onClick={startNew} testId="button-new-content"><Plus size={15} />New content</Btn>} />
    <Note tone="warn">Publish only factual, reviewed copy. Do not add customer details, payment references, receipts, invoices, credentials or other private records. Body text is rendered as escaped plain text; HTML is never executed.</Note>
    {savedMessage && <div className="notice content-saved" role="status">{savedMessage}</div>}
    <Err error={save.error || publication.error} />
    <div className="content-admin-layout">
      <section className="panel content-library" aria-labelledby="content-library-title">
        <div className="panel-head"><div><h2 id="content-library-title">Content library</h2><p>{records.length} saved {records.length === 1 ? 'entry' : 'entries'}</p></div></div>
        <div className="content-filters">
          <label><span>Type</span><select value={filterKind} onChange={(event) => setFilterKind(event.target.value as ContentKind | 'all')}><option value="all">All types</option><option value="guide">Guides</option><option value="article">Articles</option><option value="faq">FAQs</option></select></label>
          <label><span>Publication</span><select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value as ContentStatus | 'all')}><option value="all">All states</option><option value="draft">Drafts</option><option value="published">Published</option></select></label>
        </div>
        <Async q={query} empty={!filtered.length} emptyTitle={records.length ? 'No entries match these filters' : 'No public content yet'} emptyBody={records.length ? 'Choose a different type or publication state.' : 'Create a factual help answer or guide to start the public knowledge library.'}>
          <ul className="content-library-list">
            {filtered.map((record) => <li className={`content-library-item ${selectedId === record.id ? 'content-library-item-selected' : ''}`} key={record.id}>
              <div className="content-record-top"><span className="content-record-icon">{record.kind === 'guide' ? <BookOpen size={17} /> : record.kind === 'faq' ? <HelpCircle size={17} /> : <FileText size={17} />}</span><Pill value={record.status} /></div>
              <h3>{record.title}</h3><p>{record.summary}</p>
              <div className="content-record-meta"><span>{kindLabel[record.kind]}</span><span>v{record.version}</span><time dateTime={record.updatedAt}>Updated {new Date(record.updatedAt).toLocaleDateString()}</time></div>
              <div className="row-actions content-record-actions">
                <Btn variant="secondary" small onClick={() => startEditing(record)}><Pencil size={13} />Edit</Btn>
                {record.status === 'published' && <a className="btn btn-secondary btn-sm" href={routeFor(record)} target="_blank" rel="noreferrer"><Eye size={13} />View</a>}
                <Btn variant={record.status === 'published' ? 'quiet' : 'primary'} small disabled={publication.isPending} onClick={() => publication.mutate({ record, action: record.status === 'published' ? 'unpublish' : 'publish' })}>
                  {publication.isPending ? <LoaderCircle size={13} className="spin" /> : record.status === 'published' ? <EyeOff size={13} /> : <Upload size={13} />}
                  {record.status === 'published' ? 'Unpublish' : 'Publish'}
                </Btn>
              </div>
            </li>)}
          </ul>
        </Async>
      </section>

      {editing ? <section className="panel content-edit-panel" aria-labelledby="content-edit-title">
        <div className="panel-head"><div><h2 id="content-edit-title">{selectedId === null ? 'Create content' : `Edit ${current?.title ?? 'content'}`}</h2><p>Write a direct answer in the summary, then add supporting detail below.</p></div></div>
        <form className="form-stack" onSubmit={submit}>
          <Field label="Content type"><select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as ContentKind })}><option value="guide">Guide</option><option value="article">Article</option><option value="faq">FAQ</option></select></Field>
          <Field label="Title"><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} required minLength={1} maxLength={160} /></Field>
          <Field label="URL slug" hint="Lowercase letters and numbers separated by single hyphens. Slugs cannot duplicate another item."><input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} required minLength={1} maxLength={120} pattern="[a-z0-9]+(-[a-z0-9]+)*" autoCapitalize="none" /></Field>
          <Field label="Answer-first summary" hint="This is used in page descriptions, search previews and help indexes."><textarea value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} required minLength={1} maxLength={300} rows={3} /></Field>
          <Field label="Body" hint="Plain text only; separate paragraphs with a blank line. HTML and scripts are displayed as text, not executed."><textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} required minLength={1} maxLength={30000} rows={12} /></Field>
          {selectedId !== null && <div className="content-version-box">
            <button className="content-history-toggle" type="button" onClick={() => setVersionsOpen(!versionsOpen)} aria-expanded={versionsOpen}><History size={15} />Revision history{versions.isLoading ? ' · Loading' : versions.data ? ` · ${versions.data.items.length} versions` : ''}</button>
            {versionsOpen && <Async q={versions} empty={!versions.data?.items.length} emptyTitle="No saved revisions" emptyBody="A snapshot is recorded after each save, publish or unpublish."><ol className="content-version-list">{versions.data?.items.map((version) => <li key={version.id}><strong>Version {version.version}</strong><span>{kindLabel[version.kind]} · {version.status}</span><time dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleString()}</time></li>)}</ol></Async>}
          </div>}
          <div className="content-editor-footer"><span>{current ? `Current state: ${current.status} · version ${current.version}` : 'New entries are saved as drafts.'}</span><div className="row-actions"><Btn variant="secondary" onClick={() => { setEditing(false); save.reset(); }}>Cancel</Btn><Btn type="submit" disabled={save.isPending} testId="button-save-content">{save.isPending ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{selectedId === null ? 'Save draft' : 'Save changes'}</Btn></div></div>
        </form>
      </section> : <section className="panel content-edit-empty"><div className="empty-symbol"><FileText size={18} /></div><h2>{current ? current.title : 'Choose an entry to edit'}</h2><p>{current ? `${kindLabel[current.kind]} · ${current.status} · updated ${new Date(current.updatedAt).toLocaleString()}` : 'Select content from the library or create a new guide, article or FAQ.'}</p>{current && <Btn variant="secondary" onClick={() => startEditing(current)}><Pencil size={14} />Edit selected</Btn>}</section>}
    </div>
  </div>;
}

type PublicSummary = Pick<ContentRecord, 'id' | 'kind' | 'title' | 'slug' | 'summary' | 'updatedAt'>;
type PublicRecord = Omit<ContentRecord, 'status' | 'createdAt' | 'version' | 'updatedBy'>;
type PublicListResponse = { items: PublicSummary[] };

export function PublicHelpPage() {
  const branding = usePlatformBranding();
  const query = useQuery({
    queryKey: ['public-content', 'help'],
    queryFn: () => contentRequest<PublicListResponse>('/api/public/content?kind=faq'),
    staleTime: 60_000,
    refetchOnMount: true,
  });
  useEffect(() => updateBrowserMetadata(
    'Greenpay Help & Payment FAQs',
    'Get factual answers about Greenpay confirmed receipts, verified settlement wallet balances, invoices, refunds, and team permissions.',
    '/learn',
  ), []);
  return <main className="public-content-page" data-testid="page-public-help">
    <header className="public-content-header"><a href="/" className="public-content-brand">Green<span>pay</span></a><nav aria-label="Public navigation"><a href="/learn">Help & FAQs</a><a href="/guides">Guides</a><a href="/articles">Articles</a><a href="/contact">Contact support</a><a href="/sign-in">Sign in</a><a href="/admin/content">Content admin</a></nav></header>
    <article className="public-content-main"><div className="public-eyebrow">GREENPAY / HELP CENTER</div><h1>Greenpay help and payment FAQs</h1><p className="public-lead">Clear answers about payment receipts, verified settlement wallet balances, invoices, refunds and merchant team permissions. Greenpay distinguishes confirmed money from requests and estimates.</p>
      <section><h2>When is a Greenpay payment receipt confirmed?</h2><p>A receipt is available only after a transaction has a paid timestamp and a successful or refunded status. Pending payments are not confirmed receipts.</p></section>
      <section><h2>What does a verified settlement wallet balance mean?</h2><p>Wallet funding follows reconciliation of an eligible settlement using evidence. A pending settlement or T+3 forecast is not verified wallet funding. Payout requests can reserve available funds.</p></section>
      <section><h2>Does an invoice prove that money arrived?</h2><p>No. An invoice records an amount due; check its separately recorded paid amount and linked payment status. Confirmed refunds reduce the paid amount.</p></section>
      <section><h2>Does requesting a refund mean the customer has been reimbursed?</h2><p>No. A refund request or pending refund is not confirmed customer reimbursement. Use the refund record's reconciled state to determine whether money moved.</p></section>
      <section><h2>Which roles can a merchant team member have?</h2><p>Greenpay invitations assign finance or viewer access. The merchant owner manages invitations, role changes and active team membership.</p></section>
      <section><h2>More Greenpay FAQ answers</h2><Async q={query} empty={!query.data?.items.length} emptyTitle="No additional FAQs published" emptyBody="These confirmed payment facts remain available above."><ul className="public-content-list">{query.data?.items.map((item) => <li key={item.id}><a href={`/learn/${item.slug}`}><strong>{item.title}</strong><span>{item.summary}</span></a></li>)}</ul></Async></section>
      <p className="public-content-links"><a href="/guides">Browse Greenpay guides</a><a href="/articles">Read articles</a></p>
    </article>
    <footer className="public-content-footer">Greenpay · Payment records that distinguish requests, forecasts and confirmed money. <a href={import.meta.env.BASE_URL} aria-label={`Powered by ${branding.platformName} — visit homepage`} style={{ color: 'inherit', fontWeight: 600 }}>Powered by {branding.platformName}</a></footer>
  </main>;
}

export function PublicContentPage({ kind }: { kind: ContentKind }) {
  const branding = usePlatformBranding();
  const slug = window.location.pathname.split('/').filter(Boolean).at(-1) ?? '';
  const query = useQuery({
    queryKey: ['public-content', kind, slug],
    queryFn: () => contentRequest<PublicRecord>(`/api/public/content/${encodeURIComponent(slug)}`),
    enabled: Boolean(slug),
    staleTime: 60_000,
  });
  const doc = query.data;
  useEffect(() => {
    if (!doc) return;
    updateBrowserMetadata(`${doc.title} | Greenpay`, doc.summary, routeFor(doc));
  }, [doc]);
  return <main className="public-content-page">
    <header className="public-content-header"><a href="/" className="public-content-brand">Green<span>pay</span></a><nav aria-label="Public navigation"><a href="/learn">Help & FAQs</a><a href="/guides">Guides</a><a href="/articles">Articles</a><a href="/contact">Contact support</a><a href="/sign-in">Sign in</a><a href="/admin/content">Content admin</a></nav></header>
    <article className="public-content-main"><div className="public-eyebrow">GREENPAY / {kindLabel[kind].toUpperCase()}</div>
      {query.isLoading ? <p role="status">Loading published content…</p> : query.isError || !doc ? <><h1>Page not found</h1><p>This content may be unpublished or the address may be incorrect.</p><a href="/learn">Browse Greenpay help</a></> : <>
        <h1>{doc.title}</h1><p className="public-lead">{doc.summary}</p><p className="public-updated">Updated <time dateTime={doc.updatedAt}>{new Date(doc.updatedAt).toLocaleDateString()}</time></p>
        <section className="public-body">{doc.body.split(/\r?\n\s*\r?\n/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</section>
        <p className="public-content-links"><a href="/learn">Greenpay help and FAQs</a>{kind !== 'guide' && <a href="/guides">Greenpay guides</a>}</p>
      </>}
    </article>
    <footer className="public-content-footer">Greenpay · Payment records that distinguish requests, forecasts and confirmed money. <a href={import.meta.env.BASE_URL} aria-label={`Powered by ${branding.platformName} — visit homepage`} style={{ color: 'inherit', fontWeight: 600 }}>Powered by {branding.platformName}</a></footer>
  </main>;
}

export function PublicContentIndexPage({ kind }: { kind: 'guide' | 'article' }) {
  const branding = usePlatformBranding();
  const query = useQuery({
    queryKey: ['public-content', 'index', kind],
    queryFn: () => contentRequest<PublicListResponse>(`/api/public/content?kind=${kind}`),
    staleTime: 60_000,
    refetchOnMount: true,
  });
  const label = kind === 'guide' ? 'Guides' : 'Articles';
  useEffect(() => updateBrowserMetadata(
    `Greenpay ${label} | Payment operations`,
    `Published Greenpay ${label.toLowerCase()} explain payment records, settlement and finance workflows.`,
    `/${kind === 'guide' ? 'guides' : 'articles'}`,
  ), [kind, label]);
  return <main className="public-content-page">
    <header className="public-content-header"><a href="/" className="public-content-brand">Green<span>pay</span></a><nav aria-label="Public navigation"><a href="/learn">Help & FAQs</a><a href="/guides">Guides</a><a href="/articles">Articles</a><a href="/contact">Contact support</a><a href="/sign-in">Sign in</a><a href="/admin/content">Content admin</a></nav></header>
    <article className="public-content-main"><div className="public-eyebrow">GREENPAY / KNOWLEDGE</div><h1>Greenpay {label.toLowerCase()}</h1><p className="public-lead">Factual information about Greenpay payment records and the steps that connect collections, settlement and payouts.</p><Async q={query} empty={!query.data?.items.length} emptyTitle={`No ${label.toLowerCase()} published yet`} emptyBody="New Greenpay content will appear here when an administrator publishes it."><ul className="public-content-list">{query.data?.items.map((item) => <li key={item.id}><a href={`/${kind === 'guide' ? 'guides' : 'articles'}/${item.slug}`}><strong>{item.title}</strong><span>{item.summary}</span></a></li>)}</ul></Async><p className="public-content-links"><a href="/learn">Visit Greenpay help and FAQs</a></p></article>
    <footer className="public-content-footer">Greenpay · Payment records that distinguish requests, forecasts and confirmed money. <a href={import.meta.env.BASE_URL} aria-label={`Powered by ${branding.platformName} — visit homepage`} style={{ color: 'inherit', fontWeight: 600 }}>Powered by {branding.platformName}</a></footer>
  </main>;
}