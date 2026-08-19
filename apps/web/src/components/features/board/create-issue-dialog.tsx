"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/trpc/react";
import { onOpenCreateDialog } from "./create-dialog-bus";

const issueFormSchema = z.object({
  title: z.string().min(1, "Enter an issue title").max(200),
  description: z.string().max(10_000).optional(),
});
type IssueFormValues = z.infer<typeof issueFormSchema>;

/** Conventional create-Issue form in a modal dialog (React Hook Form + Zod). */
export function CreateIssueDialog() {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  // The command palette can ask for this dialog from anywhere in the shell.
  useEffect(() => onOpenCreateDialog("issue", () => setOpen(true)), []);
  const form = useForm<IssueFormValues>({
    resolver: zodResolver(issueFormSchema),
    defaultValues: { title: "", description: "" },
  });

  const create = trpc.issue.create.useMutation({
    onSuccess: () => {
      utils.issue.list.invalidate();
      form.reset();
      setOpen(false);
    },
  });

  const onSubmit = (values: IssueFormValues) => {
    const description = values.description?.trim();
    create.mutate({ title: values.title, ...(description ? { description } : {}) });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-muted-foreground hover:text-foreground"
        >
          <Plus /> New issue
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogDescription>Group related tasks under an issue.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Gate servo stalls under load" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Description <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {create.error && (
              <p className="text-destructive text-sm" role="alert">
                {create.error.message}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" loading={create.isPending}>
                Create issue
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
