import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { teamAtlasApi, type ChatMemoryStatus, type TeamAtlasIR, type TeamAtlasNode, type TeamAtlasNodeType } from '../../lib/api/team-atlas';
import { useBackendStore } from '../../stores/backend';
import { edgePath, layoutAtlas, projectAtlas } from './atlas-graph';
import './team-atlas.css';

const ASSET_OPTIONS: Array<TeamAtlasNodeType | 'all'> = ['all', 'skill', 'llm_wiki', 'code_graph', 'chat_memory'];
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
  const [zoom, setZoom] = useState(0.86);
  const [pan, setPan] = useState({ x: 20, y: 10 });
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
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
  const activeId = selectedId ?? hoveredId;
  const activeNode = layout?.nodes.find((node) => node.id === activeId) ?? null;
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

  if (loading) return <section className="team-atlas-state"><span className="team-atlas-spinner" />{t('atlas.loading')}</section>;
  if (error) return <section className="team-atlas-state team-atlas-state--error"><p>{t('atlas.loadFailed')}</p><code>{error}</code><button type="button" onClick={() => void load()}>{t('atlas.retry')}</button></section>;
  if (!ir || !layout || !projection) return null;

  const warningByNode = new Map(ir.warnings.filter((warning) => warning.node_id).map((warning) => [warning.node_id!, warning]));
  const partialSources = ir.warnings.filter((warning) => warning.code === 'SOURCE_PARTIAL').length;

  return (
    <section className="team-atlas-page" aria-label={t('atlas.title')}>
      <header className="team-atlas-header">
        <div><span className="team-atlas-eyebrow">TEAM INTELLIGENCE</span><h1>{t('atlas.title')}</h1><p>{t('atlas.subtitle')}</p></div>
        <div className="team-atlas-summary" aria-label={t('atlas.summary')}>
          <span><strong>{ir.summary.teams}</strong>{t('atlas.teams')}</span>
          <span><strong>{ir.summary.tasks}</strong>{t('atlas.tasks')}</span>
          <span><strong>{ir.summary.agents}</strong>{t('atlas.agents')}</span>
          <span><strong>{ir.summary.assets}</strong>{t('atlas.assets')}</span>
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
        <div className="team-atlas-zoom"><button type="button" aria-label={t('atlas.zoomOut')} onClick={() => setZoom((value) => Math.max(0.45, value - 0.1))}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label={t('atlas.zoomIn')} onClick={() => setZoom((value) => Math.min(1.6, value + 0.1))}>+</button><button type="button" onClick={() => { setZoom(0.86); setPan({ x: 20, y: 10 }); }}>{t('atlas.fit')}</button></div>
      </div>

      {ir.completeness === 'partial' && <div className="team-atlas-notice" role="status">{t('atlas.partial', { count: partialSources })}</div>}
      {projection.truncated && <div className="team-atlas-notice" role="status">{t('atlas.aggregated')}</div>}

      <div className="team-atlas-workspace">
        <div className="team-atlas-canvas" onWheel={(event) => { event.preventDefault(); setZoom((value) => Math.min(1.6, Math.max(0.45, value + (event.deltaY < 0 ? 0.08 : -0.08)))); }}>
          <svg
            role="img"
            aria-label={t('atlas.graphLabel')}
            viewBox={`0 0 ${layout.width} ${Math.max(620, layout.height)}`}
            onPointerDown={(event) => { if (event.target === event.currentTarget) { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; } }}
            onPointerMove={(event) => { const drag = dragRef.current; if (drag) setPan({ x: drag.panX + (event.clientX - drag.x) / zoom, y: drag.panY + (event.clientY - drag.y) / zoom }); }}
            onPointerUp={() => { dragRef.current = null; }}
          >
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              <g className="team-atlas-edges">{layout.edges.map((edge) => <path key={edge.id} d={edgePath(edge, layout.nodes)} className={activeId && (edge.source === activeId || edge.target === activeId) ? 'is-active' : ''}><title>{edge.type}</title></path>)}</g>
              <g>{layout.nodes.map((node) => {
                const active = activeId === node.id;
                const adjacent = activeId ? layout.edges.some((edge) => (edge.source === activeId && edge.target === node.id) || (edge.target === activeId && edge.source === node.id)) : false;
                const warning = warningByNode.get(node.id);
                return <g key={node.id} role="button" tabIndex={0} aria-label={`${node.type}: ${node.label}`} className={`${nodeClass(node.type)}${active ? ' is-active' : ''}${adjacent ? ' is-adjacent' : ''}`} transform={`translate(${node.x} ${node.y})`} onMouseEnter={() => onNodeEnter(node)} onMouseLeave={() => setHoveredId(null)} onClick={() => onNodeClick(node)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onNodeClick(node); }}>
                  <rect width={node.width} height={node.height} rx="12" />
                  <text className="team-atlas-node-type" x="14" y="19">{t(`atlas.type.${node.type}`)}</text>
                  <text className="team-atlas-node-label" x="14" y="41">{node.label.length > 23 ? `${node.label.slice(0, 22)}…` : node.label}</text>
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
            <dl><dt>ID</dt><dd>{activeNode.entity_id}</dd>{activeNode.team_id && <><dt>Team</dt><dd>{activeNode.team_id}</dd></>}{activeNode.status && <><dt>{t('atlas.status')}</dt><dd>{activeNode.status}</dd></>}</dl>
            {activeNode.type === 'team' && <div className="team-atlas-passport-counts"><span>Task {String(activeNode.metadata?.tasks ?? 0)}</span><span>Agent {String(activeNode.metadata?.agents ?? 0)}</span><span>Asset {String(activeNode.metadata?.assets ?? 0)}</span></div>}
            {activeNode.type === 'chat_memory' && <div className="team-atlas-memory-status"><strong>{t('atlas.memoryLayers')}</strong><span>{memoryEntry?.error ? t('atlas.statusUnavailable') : statusText(memoryEntry?.value)}</span></div>}
            {warningByNode.get(activeNode.id) && <p className="team-atlas-passport-warning">{warningByNode.get(activeNode.id)?.message}</p>}
            <button type="button" className="team-atlas-primary" onClick={() => openManagement(activeNode)}>{t('atlas.openManagement')}</button>
          </> : <p className="team-atlas-empty">{t('atlas.selectHint')}</p>}
        </aside>
      </div>
    </section>
  );
}
