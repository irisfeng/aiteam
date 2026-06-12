import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { api, type Bootstrap } from "./api";
import type { Agent, AgentStatus, Approval, Channel, Doc, Message, Project, Provider, Task, View } from "./types";

interface State {
  ready: boolean;
  user: { id: string; name: string };
  mockMode: boolean;
  agents: Agent[];
  channels: Channel[];
  tasks: Task[];
  approvals: Approval[];
  documents: Doc[];
  projects: Project[];
  providers: Provider[];
  messages: Record<string, Message[]>;
  /** channelId -> agentId -> status */
  statuses: Record<string, Record<string, AgentStatus>>;
  view: View;
}

type Action =
  | { type: "bootstrap"; data: Bootstrap }
  | { type: "view"; view: View }
  | { type: "messages"; channelId: string; messages: Message[] }
  | { type: "message:new"; message: Message }
  | { type: "message:delta"; id: string; channelId: string; delta: string }
  | { type: "message:done"; id: string; channelId: string; content: string; usage: string | null }
  | { type: "agent:status"; status: AgentStatus }
  | { type: "task:upsert"; task: Task }
  | { type: "doc:upsert"; doc: Doc }
  | { type: "project:upsert"; project: Project }
  | { type: "providers:set"; providers: Provider[] }
  | { type: "approval:upsert"; approval: Approval }
  | { type: "channel:new"; channel: Channel }
  | { type: "agent:new"; agent: Agent };

const initial: State = {
  ready: false,
  user: { id: "user", name: "我" },
  mockMode: false,
  agents: [],
  channels: [],
  tasks: [],
  approvals: [],
  documents: [],
  projects: [],
  providers: [],
  messages: {},
  statuses: {},
  view: { kind: "tasks" },
};

function upsertBy<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [item, ...list];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "bootstrap": {
      const d = action.data;
      const firstChannel = d.channels.find((c) => c.kind === "channel") ?? d.channels[0];
      return {
        ...state,
        ready: true,
        user: d.user,
        mockMode: d.mock_mode,
        agents: d.agents,
        channels: d.channels,
        tasks: d.tasks,
        approvals: d.approvals,
        documents: d.documents ?? [],
        projects: d.projects ?? [],
        providers: d.providers ?? [],
        view: firstChannel ? { kind: "channel", id: firstChannel.id } : state.view,
      };
    }
    case "view":
      return { ...state, view: action.view };
    case "messages":
      return { ...state, messages: { ...state.messages, [action.channelId]: action.messages } };
    case "message:new": {
      const m = action.message;
      const list = state.messages[m.channel_id];
      if (!list) return state; // 未加载的频道不缓存，切换时再拉取
      if (list.some((x) => x.id === m.id)) return state;
      return { ...state, messages: { ...state.messages, [m.channel_id]: [...list, m] } };
    }
    case "message:delta": {
      const list = state.messages[action.channelId];
      if (!list) return state;
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.channelId]: list.map((m) => (m.id === action.id ? { ...m, content: m.content + action.delta } : m)),
        },
      };
    }
    case "message:done": {
      const list = state.messages[action.channelId];
      if (!list) return state;
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.channelId]: list.map((m) =>
            m.id === action.id ? { ...m, content: action.content, status: "complete", usage_json: action.usage } : m
          ),
        },
      };
    }
    case "agent:status": {
      const s = action.status;
      const channel = { ...(state.statuses[s.channel_id] ?? {}) };
      if (s.state === "idle") delete channel[s.agent_id];
      else channel[s.agent_id] = s;
      return { ...state, statuses: { ...state.statuses, [s.channel_id]: channel } };
    }
    case "task:upsert":
      return { ...state, tasks: upsertBy(state.tasks, action.task) };
    case "doc:upsert":
      return { ...state, documents: upsertBy(state.documents, action.doc) };
    case "project:upsert":
      return { ...state, projects: upsertBy(state.projects, action.project) };
    case "providers:set":
      return { ...state, providers: action.providers };
    case "approval:upsert":
      return { ...state, approvals: upsertBy(state.approvals, action.approval) };
    case "channel:new":
      return state.channels.some((c) => c.id === action.channel.id)
        ? state
        : { ...state, channels: [...state.channels, action.channel] };
    case "agent:new":
      return { ...state, agents: [...state.agents, action.agent] };
    default:
      return state;
  }
}

interface Store extends State {
  setView: (v: View) => void;
  openChannel: (id: string) => void;
  send: (channelId: string, content: string) => Promise<void>;
  openDm: (agentId: string) => Promise<void>;
  createChannel: (name: string, agentIds: string[]) => Promise<void>;
  createAgent: (data: {
    name: string;
    emoji: string;
    role: string;
    system_prompt: string;
    model?: string;
    provider_id?: string | null;
  }) => Promise<void>;
  createProvider: (data: import("./api").ProviderInput) => Promise<void>;
  updateProvider: (id: string, data: import("./api").ProviderInput) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  moveTask: (task: Task, status: Task["status"]) => Promise<void>;
  resolveApproval: (id: string, approve: boolean) => Promise<void>;
  agentById: (id: string | null) => Agent | undefined;
}

const Ctx = createContext<Store | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const loadedChannels = useRef(new Set<string>());

  useEffect(() => {
    api.bootstrap().then((data) => {
      dispatch({ type: "bootstrap", data });
      const first = data.channels.find((c) => c.kind === "channel") ?? data.channels[0];
      if (first) openChannel(first.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WebSocket（断线自动重连）
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => (retry = 0);
      ws.onmessage = (ev) => {
        const { type, payload } = JSON.parse(ev.data);
        switch (type) {
          case "message:new":
            dispatch({ type: "message:new", message: payload });
            break;
          case "message:delta":
            dispatch({ type: "message:delta", id: payload.id, channelId: payload.channel_id, delta: payload.delta });
            break;
          case "message:done":
            dispatch({
              type: "message:done",
              id: payload.id,
              channelId: payload.channel_id,
              content: payload.content,
              usage: payload.usage_json,
            });
            break;
          case "agent:status":
            dispatch({ type: "agent:status", status: payload });
            break;
          case "task:upsert":
            dispatch({ type: "task:upsert", task: payload });
            break;
          case "doc:upsert":
            dispatch({ type: "doc:upsert", doc: payload });
            break;
          case "project:upsert":
            dispatch({ type: "project:upsert", project: payload });
            break;
          case "approval:upsert":
            dispatch({ type: "approval:upsert", approval: payload });
            break;
          case "channel:new":
            dispatch({ type: "channel:new", channel: payload });
            break;
        }
      };
      ws.onclose = () => {
        if (closed) return;
        retry += 1;
        setTimeout(connect, Math.min(1000 * retry, 5000));
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, []);

  const openChannel = useCallback((id: string) => {
    dispatch({ type: "view", view: { kind: "channel", id } });
    if (!loadedChannels.current.has(id)) {
      loadedChannels.current.add(id);
      api.messages(id).then((messages) => dispatch({ type: "messages", channelId: id, messages }));
    }
  }, []);

  const store = useMemo<Store>(
    () => ({
      ...state,
      setView: (view) => dispatch({ type: "view", view }),
      openChannel,
      send: async (channelId, content) => {
        await api.send(channelId, content);
      },
      openDm: async (agentId) => {
        const channel = await api.openDm(agentId);
        dispatch({ type: "channel:new", channel });
        openChannel(channel.id);
      },
      createChannel: async (name, agentIds) => {
        const channel = await api.createChannel(name, agentIds);
        dispatch({ type: "channel:new", channel });
        openChannel(channel.id);
      },
      createAgent: async (data) => {
        const agent = await api.createAgent(data);
        dispatch({ type: "agent:new", agent });
      },
      createProvider: async (data) => {
        const provider = await api.createProvider(data);
        dispatch({ type: "providers:set", providers: [...state.providers, provider] });
      },
      updateProvider: async (id, data) => {
        const provider = await api.updateProvider(id, data);
        dispatch({ type: "providers:set", providers: state.providers.map((p) => (p.id === id ? provider : p)) });
      },
      deleteProvider: async (id) => {
        await api.deleteProvider(id);
        dispatch({ type: "providers:set", providers: state.providers.filter((p) => p.id !== id) });
      },
      moveTask: async (task, status) => {
        const next = await api.updateTask(task.id, { status });
        dispatch({ type: "task:upsert", task: next });
      },
      resolveApproval: async (id, approve) => {
        const approval = await api.resolveApproval(id, approve);
        dispatch({ type: "approval:upsert", approval });
      },
      agentById: (id) => (id ? state.agents.find((a) => a.id === id) : undefined),
    }),
    [state, openChannel]
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useWorkspace(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
