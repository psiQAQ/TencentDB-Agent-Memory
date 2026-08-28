import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { teamAtlasApi, type ChatMemoryStatus, type TeamAtlasIR, type TeamAtlasNode, type TeamAtlasNodeType, type TeamAtlasRelation } from '../../lib/api/team-atlas';
import { useBackendStore } from '../../stores/backend';
import { edgeGeometry, layoutAtlas, projectAtlas, summarizeAtlas } from './atlas-graph';
import './team-atlas.css';

const ASSET_OPTIONS: Array<TeamAtlasNodeType | 'all'> = ['all', 'skill', 'llm_wiki', 'code_graph', 'chat_memory'];
const RELATIONS: TeamAtlasRelation[] = ['member_of', 'contains', 'assigned_to', 'owns', 'fixed_binding'];
const RELATION_LABEL_WIDTH: Record<TeamAtlasRelation, number> = {
  member_of: 68,
  contains: 58,
  assigned_to: 74,
  owns: 46,
  fixed_binding: 86,
};
const STATUS_CACHE_MS = 30_000;

function nodeClass(type: TeamAtlasNodeType): string {
  return `team-atlas-node team-atlas-node--${type}`;
}

function statusText(status: ChatMemoryStatus | undefined): string {
  if (!status) return '—';
  if (status.availability === 'not_applicable') return 'N/A';
  const counts = status.layer_counts;
  return `L0 ${counts.L0_messages ?? '?'} · L1 ${counts.L1 ?? '?'} · L2 ${counts.L2 ?? '?'} · L3 ${counts.L3 ?? '?'}`;
}

function shortId(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export function TeamAtlasPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setActiveTeamId = useBackendStore((state) => state.setActiveTeamId);
  const [ir, setIr] = useState<TeamAtlasIR | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [assetType, setAssetType] = useState<TeamAtlasNodeType | 'all'>('all');
  const [focusTeamId, setFocusTeamId] = useState<string | null>(null);
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.96);
  const [pan, setPan] = useState({ x: 10, y: 10 });
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const statusCache = useRef(new Map<string, { expires: number; value?: ChatMemoryStatus; error?: string }>());
  const [memoryVersion, setMemoryVersion] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setIr(await teamAtlasApi.bootstrap());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); }, []);

  const projection = useMemo(() => ir ? projectAtlas(ir, { focusTeamId, focusAgentId, query, assetType }) : null, [ir, focusTeamId, focusAgentId, query, assetType]);
  const layout = useMemo(() => projection ? layoutAtlas(projection) : null, [projection]);
  const summaryCards = useMemo(() => ir ? summarizeAtlas(ir) : [], [ir]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setZoom((value) => Math.min(1.6, Math.max(0.45, value + (event.deltaY < 0 ? 0.08 : -0.08))));
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [layout]);
  const activeId = selectedId ?? hoveredId;
  const activeNode = layout?.nodes.find((node) => node.id === activeId) ?? null;
  const activeRelations = activeNode && layout ? layout.edges
    .filter((edge) => edge.source === activeNode.id || edge.target === activeNode.id)
    .map((edge) => ({
      edge,
      outgoing: edge.source === activeNode.id,
      peer: layout.nodes.find((node) => node.id === (edge.source === activeNode.id ? edge.target : edge.source)),
    })) : [];
  const memoryEntry = activeNode?.type === 'chat_memory' ? statusCache.current.get(activeNode.entity_id) : undefined;
  void memoryVersion;

  const fetchMemoryStatus = useCallback((node: TeamAtlasNode) => {
    if (node.type !== 'chat_memory') return;
    const cached = statusCache.current.get(node.entity_id);
    if (cached && cached.expires > Date.now()) return;
    statusCache.current.set(node.entity_id, { expires: Date.now() + STATUS_CACHE_MS });
    void teamAtlasApi.memoryStatus(node.entity_id).then((value) => {
      statusCache.current.set(node.entity_id, { expires: Date.now() + STATUS_CACHE_MS, value });
      setMemoryVersion((version) => version + 1);
    }).catch((err) => {
      statusCache.current.set(node.entity_id, { expires: Date.now() + STATUS_CACHE_MS, error: err instanceof Error ? err.message : String(err) });
      setMemoryVersion((version) => version + 1);
    });
  }, []);

  const onNodeEnter = useCallback((node: TeamAtlasNode) => {
    setHoveredId(node.id);
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => fetchMemoryStatus(node), 250);
  }, [fetchMemoryStatus]);

  const onNodeClick = useCallback((node: TeamAtlasNode) => {
    setSelectedId(node.id);
    fetchMemoryStatus(node);
    if (node.type === 'team' && projection?.mode === 'team_summary') {
      setFocusTeamId(node.entity_id);
      setFocusAgentId(null);
      setSelectedId(null);
    } else if (node.type === 'agent' && projection?.truncated) {
      setFocusAgentId(node.entity_id);
      setSelectedId(null);
    }
  }, [fetchMemoryStatus, projection?.mode, projection?.truncated]);

  const openManagement = useCallback((node: TeamAtlasNode) => {
    if (node.team_id) setActiveTeamId(node.team_id);
    const path = node.type === 'team' ? '/team/members'
      : node.type === 'agent' ? '/team/agents'
        : node.type === 'task' ? '/'
          : node.type === 'skill' ? '/skills'
            : node.type === 'llm_wiki' ? '/wiki'
              : node.type === 'code_graph' ? '/code'
                : node.type === 'chat_memory' ? '/memory' : '/';
    navigate(path);
  }, [navigate, setActiveTeamId]);

  const nodeCaption = useCallback((node: TeamAtlasNode) => {
    if (!layout) return '';
    const outgoing = layout.edges.filter((edge) => edge.source === node.id);
    const owner = node.metadata?.owner_user_id;
    if (node.type === 'identity') return t('atlas.currentIdentity');
    if (node.type === 'team') return `${t('atlas.owner')} ${shortId(owner)}`;
    if (node.type === 'task') return `Agent ${outgoing.filter((edge) => edge.type === 'assigned_to').length} · ${t('atlas.creator')} ${shortId(node.metadata?.creator_user_id)}`;
    if (node.type === 'agent') return `${t('atlas.owner')} ${shortId(owner)}`;
    return `${t('atlas.visibility')} ${String(node.metadata?.visibility ?? '—')} · ${t('atlas.owner')} ${shortId(owner)}`;
  }, [layout, t]);

  if (loading) return <section className="team-atlas-state"><span className="team-atlas-spinner" />{t('atlas.loading')}</section>;
  if (error) return <section className="team-atlas-state team-atlas-state--error"><p>{t('atlas.loadFailed')}</p><code>{error}</code><button type="button" onClick={() => void load()}>{t('atlas.retry')}</button></section>;
  if (!ir || !layout || !projection) return null;

  const warningByNode = new Map(ir.warnings.filter((warning) => warning.node_id).map((warning) => [warning.node_id!, warning]));
  const partialSources = ir.warnings.filter((warning) => warning.code === 'SOURCE_PARTIAL').length;

  return (
    <section className="team-atlas-page" aria-label={t('atlas.title')}>
      <header className="team-atlas-header">
        <div className="team-atlas-summary" aria-label={t('atlas.summary')}>
          {summaryCards.map((card) => <span key={card.type} title={`${t(`atlas.type.${card.type}`)} · ${t('atlas.mineVisible')}`}>
            <strong><b>{card.mine}</b><em>/</em>{card.visible}</strong>
            <small>{t(`atlas.type.${card.type}`)}</small>
          </span>)}
        </div>
      </header>

      <div className="team-atlas-toolbar">
        <label><span className="sr-only">{t('atlas.search')}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('atlas.search')} /></label>
        <label><span className="sr-only">{t('atlas.assetType')}</span><select value={assetType} onChange={(event) => setAssetType(event.target.value as TeamAtlasNodeType | 'all')}>{ASSET_OPTIONS.map((type) => <option key={type} value={type}>{t(`atlas.type.${type}`)}</option>)}</select></label>
        <div className="team-atlas-breadcrumb">
          <button type="button" onClick={() => { setFocusTeamId(null); setFocusAgentId(null); setSelectedId(null); }}>{t('atlas.allTeams')}</button>
          {focusTeamId && <><span>/</span><button type="button" onClick={() => { setFocusAgentId(null); setSelectedId(null); }}>{ir.nodes.find((node) => node.id === `team:${focusTeamId}`)?.label ?? focusTeamId}</button></>}
          {focusAgentId && <><span>/</span><span>{ir.nodes.find((node) => node.id === `agent:${focusAgentId}`)?.label ?? focusAgentId}</span></>}
        </div>
        <div className="team-atlas-zoom"><button type="button" aria-label={t('atlas.zoomOut')} onClick={() => setZoom((value) => Math.max(0.45, value - 0.1))}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label={t('atlas.zoomIn')} onClick={() => setZoom((value) => Math.min(1.6, value + 0.1))}>+</button><button type="button" onClick={() => { setZoom(0.96); setPan({ x: 10, y: 10 }); }}>{t('atlas.fit')}</button></div>
      </div>

      {ir.completeness === 'partial' && <div className="team-atlas-notice" role="status">{t('atlas.partial', { count: partialSources })}</div>}
      {projection.truncated && <div className="team-atlas-notice" role="status">{t('atlas.aggregated')}</div>}

      <div className="team-atlas-relation-guide" aria-label={t('atlas.relationGuide')}>
        <div className="team-atlas-relation-explanation"><strong>{t('atlas.relationGuide')}</strong><span>{t('atlas.relationExplanation')}</span></div>
        <div className="team-atlas-relation-legend">{RELATIONS.map((relation) => <span key={relation}><i className={`team-atlas-relation-swatch team-atlas-relation-swatch--${relation}`} />{t(`atlas.relation.${relation}`)}</span>)}</div>
      </div>

      <div className="team-atlas-workspace">
        <div ref={canvasRef} className="team-atlas-canvas">
          <svg
            role="img"
            aria-label={t('atlas.graphLabel')}
            viewBox={`0 0 ${layout.width} ${Math.max(620, layout.height)}`}
            style={{ height: Math.max(620, layout.height) }}
            onPointerDown={(event) => { if (event.target === event.currentTarget) { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; } }}
            onPointerMove={(event) => { const drag = dragRef.current; if (drag) setPan({ x: drag.panX + (event.clientX - drag.x) / zoom, y: drag.panY + (event.clientY - drag.y) / zoom }); }}
            onPointerUp={() => { dragRef.current = null; }}
          >
            <defs>{RELATIONS.map((relation) => <marker key={relation} id={`atlas-arrow-${relation}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path className={`team-atlas-arrow team-atlas-arrow--${relation}`} d="M 0 0 L 10 5 L 0 10 z" /></marker>)}</defs>
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              <g className="team-atlas-edges">{layout.edges.map((edge) => {
                const geometry = edgeGeometry(edge, layout.nodes, layout.edges);
                const active = Boolean(activeId && (edge.source === activeId || edge.target === activeId));
                const labelWidth = RELATION_LABEL_WIDTH[edge.type];
                return <g key={edge.id} className={`team-atlas-edge team-atlas-edge--${edge.type}${active ? ' is-active' : ''}`}>
                  <path d={geometry.path} markerEnd={`url(#atlas-arrow-${edge.type})`}><title>{t(`atlas.relation.${edge.type}`)}</title></path>
                  <g className="team-atlas-edge-label" transform={`translate(${geometry.labelX} ${geometry.labelY})`}>
                    <rect x={-labelWidth / 2} y="-10" width={labelWidth} height="16" rx="5" />
                    <text y="2">{t(`atlas.relation.${edge.type}`)}</text>
                  </g>
                </g>;
              })}</g>
              <g>{layout.nodes.map((node) => {
                const active = activeId === node.id;
                const adjacent = activeId ? layout.edges.some((edge) => (edge.source === activeId && edge.target === node.id) || (edge.target === activeId && edge.source === node.id)) : false;
                const warning = warningByNode.get(node.id);
                const caption = nodeCaption(node);
                return <g key={node.id} role="button" tabIndex={0} aria-label={`${node.type}: ${node.label}`} className={`${nodeClass(node.type)}${active ? ' is-active' : ''}${adjacent ? ' is-adjacent' : ''}`} transform={`translate(${node.x} ${node.y})`} onMouseEnter={() => onNodeEnter(node)} onMouseLeave={() => setHoveredId(null)} onClick={() => onNodeClick(node)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onNodeClick(node); }}>
                  <rect width={node.width} height={node.height} rx="12" />
                  <text className="team-atlas-node-type" x="14" y="18">{t(`atlas.type.${node.type}`)}{node.status ? ` · ${node.status}` : ''}</text>
                  <text className="team-atlas-node-label" x="14" y="41">{node.label.length > 27 ? `${node.label.slice(0, 26)}…` : node.label}</text>
                  <text className="team-atlas-node-caption" x="14" y="62">{caption.length > 40 ? `${caption.slice(0, 39)}…` : caption}</text>
                  {warning && <g className="team-atlas-warning" transform={`translate(${node.width - 18} 14)`}><circle r="8" /><text y="4">!</text><title>{warning.message}</title></g>}
                  <title>{`${node.label} · ${node.entity_id}`}</title>
                </g>;
              })}</g>
            </g>
          </svg>
        </div>

        <aside className="team-atlas-passport" aria-live="polite">
          <span className="team-atlas-eyebrow">PASSPORT</span>
          {activeNode ? <>
            <h2>{activeNode.label}</h2><span className="team-atlas-pill">{t(`atlas.type.${activeNode.type}`)}</span>
            <dl><dt>ID</dt><dd>{activeNode.entity_id}</dd>{activeNode.team_id && <><dt>Team</dt><dd>{activeNode.team_id}</dd></>}{activeNode.status && <><dt>{t('atlas.status')}</dt><dd>{activeNode.status}</dd></>}{activeNode.metadata?.owner_user_id && <><dt>{t('atlas.owner')}</dt><dd>{String(activeNode.metadata.owner_user_id)}</dd></>}{activeNode.metadata?.creator_user_id && <><dt>{t('atlas.creator')}</dt><dd>{String(activeNode.metadata.creator_user_id)}</dd></>}{activeNode.metadata?.visibility && <><dt>{t('atlas.visibility')}</dt><dd>{String(activeNode.metadata.visibility)}</dd></>}</dl>
            {activeNode.type === 'team' && <div className="team-atlas-passport-counts"><span>Task {String(activeNode.metadata?.tasks ?? 0)}</span><span>Agent {String(activeNode.metadata?.agents ?? 0)}</span><span>Asset {String(activeNode.metadata?.assets ?? 0)}</span></div>}
            {activeNode.type === 'chat_memory' && <div className="team-atlas-memory-status"><strong>{t('atlas.memoryLayers')}</strong><span>{memoryEntry?.error ? t('atlas.statusUnavailable') : statusText(memoryEntry?.value)}</span></div>}
            {activeRelations.length > 0 && <div className="team-atlas-passport-relations"><strong>{t('atlas.connections')}</strong>{activeRelations.map(({ edge, outgoing, peer }) => <span key={edge.id}><i className={`team-atlas-relation-swatch team-atlas-relation-swatch--${edge.type}`} />{outgoing ? '→' : '←'} {t(`atlas.relation.${edge.type}`)} · {peer?.label ?? (outgoing ? edge.target : edge.source)}</span>)}</div>}
            {warningByNode.get(activeNode.id) && <p className="team-atlas-passport-warning">{warningByNode.get(activeNode.id)?.message}</p>}
            <button type="button" className="team-atlas-primary" onClick={() => openManagement(activeNode)}>{t('atlas.openManagement')}</button>
          </> : <p className="team-atlas-empty">{t('atlas.selectHint')}</p>}
        </aside>
      </div>
    </section>
  );
}
