import { Board } from "@/components/features/board/board";
import { BoardToolbar } from "@/components/features/board/board-toolbar";

export default function BoardPage() {
  return (
    <>
      <BoardToolbar />
      <Board />
    </>
  );
}
