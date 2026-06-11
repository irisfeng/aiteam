import { useState } from "react";
import { useWorkspace } from "./store";
import { Sidebar } from "./components/Sidebar";
import { ChannelView } from "./components/ChannelView";
import { TasksBoard } from "./components/TasksBoard";
import { InboxView } from "./components/InboxView";
import { DocsView } from "./components/DocsView";
import { NewAgentModal, NewChannelModal } from "./components/Modals";

export default function App() {
  const ws = useWorkspace();
  const [modal, setModal] = useState<"channel" | "agent" | null>(null);

  if (!ws.ready) {
    return <div className="flex h-full items-center justify-center text-ink-3">加载中…</div>;
  }

  return (
    <div className="flex h-full">
      <Sidebar onNewChannel={() => setModal("channel")} onNewAgent={() => setModal("agent")} />
      <main className="flex h-full min-w-0 flex-1">
        {ws.view.kind === "channel" && <ChannelView channelId={ws.view.id} />}
        {ws.view.kind === "tasks" && <TasksBoard />}
        {ws.view.kind === "inbox" && <InboxView />}
        {ws.view.kind === "docs" && <DocsView />}
      </main>
      {modal === "channel" && <NewChannelModal onClose={() => setModal(null)} />}
      {modal === "agent" && <NewAgentModal onClose={() => setModal(null)} />}
    </div>
  );
}
