import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CpQueuesPage } from "../../src/components/cp/CpQueuesPage";
import { Button } from "../../src/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../src/components/ui/dialog";
import { ResourceSelect } from "../../src/components/ui/resource-picker";
import { setLang } from "../../src/lib/i18n";

setLang("zh");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Fixture() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  return (
    <QueryClientProvider client={client}>
      <CpQueuesPage />
      <Button onClick={() => setOpen(true)}>其他表单</Button>
      <ResourceSelect
        label="外部选择"
        options={Array.from({ length: 30 }, (_, i) => ({ value: `${i}`, label: `选项 ${i}` }))}
        value={value}
        onValueChange={setValue}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>其他表单</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4 overflow-y-auto p-5"
            onSubmit={(event) => {
              event.preventDefault();
              setOpen(false);
            }}
          >
            {Array.from({ length: 30 }, (_, i) => `表单字段 ${i}`).map((label) => (
              <p key={label}>{label}</p>
            ))}
            <Button type="submit">完成</Button>
          </form>
        </DialogContent>
      </Dialog>
    </QueryClientProvider>
  );
}
const router = createRouter({
  routeTree: createRootRoute({ component: Fixture }),
  history: createMemoryHistory(),
});
createRoot(document.getElementById("root") as HTMLElement).render(
  <RouterProvider router={router} />,
);
