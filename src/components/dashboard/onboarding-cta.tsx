import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type OnboardingCtaProps = {
  title: string;
  description: string;
  ctaLabel: string;
  href: string;
};

export function OnboardingCta({
  title,
  description,
  ctaLabel,
  href,
}: OnboardingCtaProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Link href={href} className={cn(buttonVariants({ variant: "default" }))}>
          {ctaLabel}
        </Link>
      </CardContent>
    </Card>
  );
}
