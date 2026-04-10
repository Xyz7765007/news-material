"use client";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
const SignalScope = dynamic(() => import("@/components/SignalScope"), { ssr: false });
export default function ClientPage() {
  const { id } = useParams();
  return <SignalScope clientMode={true} fixedCampaignId={id} />;
}
