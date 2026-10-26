import { NewBusinessForm } from "./form";

export default function NewBusinessPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Add business</h1>
      </header>
      <NewBusinessForm />
    </div>
  );
}
