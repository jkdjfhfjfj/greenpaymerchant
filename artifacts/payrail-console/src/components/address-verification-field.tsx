import { useEffect, useState } from "react";
import { LoaderCircle, MapPin, ShieldCheck } from "lucide-react";
import {
  useGetMerchantAddressSuggestions,
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
  const [searchText, setSearchText] = useState("");
  const [suggestionSelected, setSuggestionSelected] = useState(false);
  useEffect(() => {
    const query = address.trim();
    if (query.length < 3 || suggestionSelected || draft.method === "automatic") {
      setSearchText("");
      return;
    }
    const timer = window.setTimeout(() => setSearchText(query), 300);
    return () => window.clearTimeout(timer);
  }, [address, draft.method, suggestionSelected]);
  const suggestionsQuery = useGetMerchantAddressSuggestions({ text: searchText });
  const isCurrentSearch = searchText.length >= 3 && searchText.toLocaleLowerCase() === address.trim().toLocaleLowerCase();
  const suggestions = isCurrentSearch ? suggestionsQuery.data?.suggestions ?? [] : [];

  function changeAddress(value: string) {
    setSuggestionSelected(false);
    onAddressChange(value);
    if (draft.method === "automatic") {
      onDraftChange({ method: null, proofToken: null, manualReason: "" });
    }
  }

  function chooseSuggestion(suggestion: { address: string }) {
    setLookupError("");
    setSearchText("");
    setSuggestionSelected(true);
    onAddressChange(suggestion.address);
    if (draft.method === "automatic") {
      onDraftChange({ method: null, proofToken: null, manualReason: "" });
    }
  }

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
      setSuggestionSelected(true);
      setSearchText("");
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
    <div className="address-autocomplete">
      <Field
        label="Registered address"
        hint={required
          ? "Use device location for an automatic address match, or enter an address and send it to Greenpay for manual review."
          : "Enter the registered business address. Suggestions appear as you type."}
      >
        <input
          name="registeredAddress"
          type="text"
          autoComplete="street-address"
          required
          minLength={5}
          maxLength={500}
          value={address}
          readOnly={required && draft.method === "automatic"}
          aria-autocomplete="list"
          aria-controls="merchant-address-suggestions"
          aria-expanded={suggestions.length > 0}
          onChange={(event) => changeAddress(event.target.value)}
          data-testid="input-registered-address"
        />
      </Field>
      {isCurrentSearch && suggestionsQuery.isFetching && <span className="address-suggestion-status">Finding addresses…</span>}
      {isCurrentSearch && suggestions.length > 0 && <div id="merchant-address-suggestions" className="address-suggestion-list" role="group" aria-label="Address suggestions">
        {suggestions.map((suggestion, index) => <button
          key={`${suggestion.address}:${suggestion.latitude}:${suggestion.longitude}`}
          type="button"
          className="address-suggestion"
          onClick={() => chooseSuggestion(suggestion)}
          data-testid={`button-address-suggestion-${index}`}
        >
          {suggestion.address}
        </button>)}
      </div>}
      {isCurrentSearch && suggestionsQuery.isError && <span className="address-suggestion-status">Address suggestions are unavailable. Keep typing or use device location/manual review.</span>}
      {isCurrentSearch && !suggestionsQuery.isFetching && !suggestionsQuery.isError && !suggestions.length && suggestionsQuery.data && <span className="address-suggestion-status">No suggestions found. Keep typing or enter the address manually.</span>}
    </div>
    <Note>
      Address suggestions are powered by Geoapify. Attribution:{" "}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
      {" · "}
      <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Powered by Geoapify</a>. Suggestions help complete the address but do not verify your location.
    </Note>
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
        <Note tone="warn">This address stays pending until the application is reviewed. You can add a supporting document through the application documents upload; files are private to authorized reviewers.</Note>
      </>}
      {lookupError && <Note tone="warn">{lookupError}</Note>}
    </>}
  </div>;
}