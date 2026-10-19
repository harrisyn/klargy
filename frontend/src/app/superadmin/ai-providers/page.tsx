import { redirect } from 'next/navigation';

// Merged into Platform services.
export default function Page() {
  redirect('/superadmin/platform-services?tile=ai:anthropic');
}
