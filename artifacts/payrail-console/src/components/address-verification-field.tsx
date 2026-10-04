import { useState } from "react";
import { LoaderCircle, MapPin, ShieldCheck } from "lucide-react";
import {
  useReverseGeocodeMerchantAddress,
  type AddressVerificationSubmission,
} from "@workspace/api-client-react";
import { Btn, Field, Note } from "@/components/kit";

export type AddressVerificationDraft = {
  method: "automatic" | "manual_review" | null;
  proofToken: string | null;
  manualReason: string;
};

export function addressVerificationSubmission(
  draft: AddressVerificationDraft,
  address: string,
): AddressVerificationSubmission | null {
  if (draft.method === "automatic" && draft.proofToken) {
    return { method: "automatic", proofToken: draft.proofToken };
  }
  if (draft.method === "manual_review" &&
      address.trim().length >= 5 &&
      draft.manualReason.trim().length >= 5) {
    return { method: "manual_review", reason: draft.manualReason.trim() };
  }
  return null;
}

export function AddressVerificationField({
  address,
  onAddressChange,
  draft,
  onDraftChange,
  required,
}: {
  address: string;
  onAddressChange: (address: string) => void;
  draft: AddressVerificationDraft;
  onDraftChange: (draft: AddressVerificationDraft) => void;
  required: boolean;
}) {
  const geocode = useReverseGeocodeMerchantAddress();
  const [lookupError, setLookupError] = useState("");

  async function getDeviceAddress() {
    setLookupError("");
    if (!navigator.geolocation) {
      setLookupError("This browser does not provide device location. Enter your address manually for review.");
      return;
    }
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 12_000,
          maximumAge: 60_000,
        });
      });
      const result = await geocode.mutateAsync({ data: {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      } });
      onAddressChange(result.address);
      onDraftChange({
        method: "automatic",
        proofToken: result.verificationToken,
        manualReason: "",
      });
    } catch (error) {
      const geolocationError = error as GeolocationPositionError;
      setLookupError(
        typeof geolocationError?.code === "number"
          ? "Your location could not be read. Check browser permission or enter the address manually for review."
          : error instanceof Error
            ? error.message
            : "Automatic address lookup failed. Enter the address manually for review.",
      );
    }
  }

  function chooseManualReview() {
    setLookupError("");
    onDraftChange({ method: "manual_review", proofToken: null, manualReason: "" });
  }

  return <div className="form-stack" data-testid="section-address-verification">
    <Field
      label="Registered address"
      hint={required
        ? "Use device location for an automatic address match, or enter an address and send it to Greenpay for manual review."
        : "Enter the registered business address."}
    >
      <textarea
        name="registeredAddress"
        required
        minLength={5}
        maxLength={500}
        value={address}
        readOnly={required && draft.method === "automatic"}
        onChange={(event) => onAddressChange(event.target.value)}
        data-testid="input-registered-address"
      />
    </Field>
    {required && <>
      <div className="row-actions">
        <Btn
          type="button"
          variant={draft.method === "automatic" ? "primary" : "secondary"}
          disabled={geocode.isPending}
          onClick={() => void getDeviceAddress()}
          testId="button-address-use-location"
        >
          {geocode.isPending ? <LoaderCircle size={14} className="spin" /> : <MapPin size={14} />}
          {geocode.isPending ? "Looking up address…" : draft.method === "automatic" ? "Refresh device location" : "Use device location"}
        </Btn>
        <Btn
          type="button"
          variant={draft.method === "manual_review" ? "primary" : "secondary"}
          disabled={geocode.isPending}
          onClick={chooseManualReview}
          testId="button-address-manual-review"
        >
          Enter manually for review
        </Btn>
      </div>
      <Note>
        Device location is used only for the address lookup. Attribution:{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
        {" · "}
        <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Powered by Geoapify</a>.
      </Note>
      {draft.method === "automatic" && draft.proofToken && <Note>
        <ShieldCheck size={14} /> Address matched from your device location. You can refresh the lookup or switch to manual review.
      </Note>}
      {draft.method === "manual_review" && <>
        <Field label="Why should Greenpay review this address?" hint="Required for manual submissions · at least 5 characters">
          <textarea
            value={draft.manualReason}
            required
            minLength={5}
            maxLength={1000}
            onChange={(event) => onDraftChange({
              ...draft,
              manualReason: event.target.value,
            })}
            placeholder="For example, device location is unavailable or the returned address is incomplete."
            data-testid="input-address-manual-review-reason"
          />
        </Field>
        <Note tone="warn">This address will be reviewed together with your application before it can be approved.</Note>
      </>}
      {lookupError && <Note tone="warn">{lookupError}</Note>}
    </>}
  </div>;
}