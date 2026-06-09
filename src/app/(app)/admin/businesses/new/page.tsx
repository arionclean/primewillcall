import { NewBusinessForm } from "./form";

export default function NewBusinessPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Add business</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A business is a tenant under the Prime master account.
        </p>
      </header>
      <NewBusinessForm />
    </div>
  );
}
