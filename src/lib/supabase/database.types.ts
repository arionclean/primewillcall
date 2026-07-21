export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string
          actor_kiosk_id: string | null
          actor_staff_id: string | null
          entity: string
          entity_id: string | null
          id: number
          occurred_at: string
          payload: Json
        }
        Insert: {
          action: string
          actor_kiosk_id?: string | null
          actor_staff_id?: string | null
          entity: string
          entity_id?: string | null
          id?: number
          occurred_at?: string
          payload?: Json
        }
        Update: {
          action?: string
          actor_kiosk_id?: string | null
          actor_staff_id?: string | null
          entity?: string
          entity_id?: string | null
          id?: number
          occurred_at?: string
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_kiosk_id_fkey"
            columns: ["actor_kiosk_id"]
            isOneToOne: false
            referencedRelation: "kiosks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_actor_staff_id_fkey"
            columns: ["actor_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          business_id: string
          business_tour_id: string
          checked_in_at: string | null
          checked_in_by_staff_id: string | null
          created_at: string
          created_by_staff_id: string | null
          currency: string
          customer_id: string
          ends_at: string
          groupon_redeemed_at: string | null
          groupon_voucher_urls: string[]
          id: string
          legacy_id: string | null
          legacy_reference: string | null
          notes: string | null
          paid_at: string | null
          pax_adult: number
          pax_child: number
          pax_infant: number
          peek: boolean
          public_token: string
          source_channel: string | null
          starts_at: string
          status: Database["public"]["Enums"]["booking_status"]
          stripe_payment_intent_id: string | null
          total_cents: number
          tour_pax_breakdown: Json
          updated_at: string
        }
        Insert: {
          business_id: string
          business_tour_id: string
          checked_in_at?: string | null
          checked_in_by_staff_id?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          currency?: string
          customer_id: string
          ends_at: string
          groupon_redeemed_at?: string | null
          groupon_voucher_urls?: string[]
          id?: string
          legacy_id?: string | null
          legacy_reference?: string | null
          notes?: string | null
          paid_at?: string | null
          pax_adult?: number
          pax_child?: number
          pax_infant?: number
          peek?: boolean
          public_token?: string
          source_channel?: string | null
          starts_at: string
          status?: Database["public"]["Enums"]["booking_status"]
          stripe_payment_intent_id?: string | null
          total_cents: number
          tour_pax_breakdown?: Json
          updated_at?: string
        }
        Update: {
          business_id?: string
          business_tour_id?: string
          checked_in_at?: string | null
          checked_in_by_staff_id?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          currency?: string
          customer_id?: string
          ends_at?: string
          groupon_redeemed_at?: string | null
          groupon_voucher_urls?: string[]
          id?: string
          legacy_id?: string | null
          legacy_reference?: string | null
          notes?: string | null
          paid_at?: string | null
          pax_adult?: number
          pax_child?: number
          pax_infant?: number
          peek?: boolean
          public_token?: string
          source_channel?: string | null
          starts_at?: string
          status?: Database["public"]["Enums"]["booking_status"]
          stripe_payment_intent_id?: string | null
          total_cents?: number
          tour_pax_breakdown?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_business_tour_id_fkey"
            columns: ["business_tour_id"]
            isOneToOne: false
            referencedRelation: "business_tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_checked_in_by_staff_id_fkey"
            columns: ["checked_in_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_created_by_staff_id_fkey"
            columns: ["created_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings_legacy_raw: {
        Row: {
          id: number
          imported_at: string
          row: Json
        }
        Insert: {
          id?: never
          imported_at?: string
          row: Json
        }
        Update: {
          id?: never
          imported_at?: string
          row?: Json
        }
        Relationships: []
      }
      business_tours: {
        Row: {
          business_id: string
          created_at: string
          groupon_fee_cents: number | null
          id: string
          is_active: boolean
          legacy_product_id: string | null
          name: string
          tour_id: string
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          groupon_fee_cents?: number | null
          id?: string
          is_active?: boolean
          legacy_product_id?: string | null
          name: string
          tour_id: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          groupon_fee_cents?: number | null
          id?: string
          is_active?: boolean
          legacy_product_id?: string | null
          name?: string
          tour_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_tours_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_tours_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
        ]
      }
      businesses: {
        Row: {
          address: string | null
          contact_email: string | null
          created_at: string
          google_review_url: string | null
          id: string
          legacy_company_id: string | null
          logo_url: string | null
          name: string
          phone: string | null
          slug: string
          stripe_account_id: string | null
          stripe_account_synced_at: string | null
          stripe_charges_enabled: boolean
          stripe_details_submitted: boolean
          stripe_payouts_enabled: boolean
          stripe_requirements_due: number
          timezone: string
          updated_at: string
          whatsapp_number: string | null
        }
        Insert: {
          address?: string | null
          contact_email?: string | null
          created_at?: string
          google_review_url?: string | null
          id?: string
          legacy_company_id?: string | null
          logo_url?: string | null
          name: string
          phone?: string | null
          slug: string
          stripe_account_id?: string | null
          stripe_account_synced_at?: string | null
          stripe_charges_enabled?: boolean
          stripe_details_submitted?: boolean
          stripe_payouts_enabled?: boolean
          stripe_requirements_due?: number
          timezone?: string
          updated_at?: string
          whatsapp_number?: string | null
        }
        Update: {
          address?: string | null
          contact_email?: string | null
          created_at?: string
          google_review_url?: string | null
          id?: string
          legacy_company_id?: string | null
          logo_url?: string | null
          name?: string
          phone?: string | null
          slug?: string
          stripe_account_id?: string | null
          stripe_account_synced_at?: string | null
          stripe_charges_enabled?: boolean
          stripe_details_submitted?: boolean
          stripe_payouts_enabled?: boolean
          stripe_requirements_due?: number
          timezone?: string
          updated_at?: string
          whatsapp_number?: string | null
        }
        Relationships: []
      }
      cash_sales: {
        Row: {
          amount_cents: number
          booking_id: string | null
          booking_ref: string | null
          business_id: string
          created_at: string
          dedup_key: string | null
          id: string
          kiosk_id: string | null
          kiosk_slug: string | null
          product: string | null
          source: string
          status: string
          type: string
        }
        Insert: {
          amount_cents?: number
          booking_id?: string | null
          booking_ref?: string | null
          business_id: string
          created_at?: string
          dedup_key?: string | null
          id?: string
          kiosk_id?: string | null
          kiosk_slug?: string | null
          product?: string | null
          source?: string
          status?: string
          type?: string
        }
        Update: {
          amount_cents?: number
          booking_id?: string | null
          booking_ref?: string | null
          business_id?: string
          created_at?: string
          dedup_key?: string | null
          id?: string
          kiosk_id?: string | null
          kiosk_slug?: string | null
          product?: string | null
          source?: string
          status?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_sales_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_sales_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_sales_kiosk_id_fkey"
            columns: ["kiosk_id"]
            isOneToOne: false
            referencedRelation: "kiosks"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          business_id: string
          created_at: string
          dedup_key: string | null
          email: string | null
          full_name: string
          id: string
          legacy_source: string | null
          notes: string | null
          phone: string | null
          stripe_customer_id: string | null
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          dedup_key?: string | null
          email?: string | null
          full_name: string
          id?: string
          legacy_source?: string | null
          notes?: string | null
          phone?: string | null
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          dedup_key?: string | null
          email?: string | null
          full_name?: string
          id?: string
          legacy_source?: string | null
          notes?: string | null
          phone?: string | null
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      email_match_queue: {
        Row: {
          ai_confidence: string | null
          booking_channel: string | null
          business_id: string | null
          created_at: string
          id: string
          legacy_company_id: string | null
          original_product_name: string | null
          parsed: Json | null
          reason: string
          resolved_at: string | null
          resolved_by_staff_id: string | null
          resolved_tour_id: string | null
          status: string
          suggested_tour_id: string | null
          supplier: string | null
        }
        Insert: {
          ai_confidence?: string | null
          booking_channel?: string | null
          business_id?: string | null
          created_at?: string
          id?: string
          legacy_company_id?: string | null
          original_product_name?: string | null
          parsed?: Json | null
          reason: string
          resolved_at?: string | null
          resolved_by_staff_id?: string | null
          resolved_tour_id?: string | null
          status?: string
          suggested_tour_id?: string | null
          supplier?: string | null
        }
        Update: {
          ai_confidence?: string | null
          booking_channel?: string | null
          business_id?: string | null
          created_at?: string
          id?: string
          legacy_company_id?: string | null
          original_product_name?: string | null
          parsed?: Json | null
          reason?: string
          resolved_at?: string | null
          resolved_by_staff_id?: string | null
          resolved_tour_id?: string | null
          status?: string
          suggested_tour_id?: string | null
          supplier?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_match_queue_ai_suggested_tour_id_fkey"
            columns: ["suggested_tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_match_queue_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_match_queue_resolved_by_staff_id_fkey"
            columns: ["resolved_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_match_queue_resolved_tour_id_fkey"
            columns: ["resolved_tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
        ]
      }
      kiosk_tours: {
        Row: {
          created_at: string
          kiosk_id: string
          tour_id: string
        }
        Insert: {
          created_at?: string
          kiosk_id: string
          tour_id: string
        }
        Update: {
          created_at?: string
          kiosk_id?: string
          tour_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "kiosk_tours_kiosk_id_fkey"
            columns: ["kiosk_id"]
            isOneToOne: false
            referencedRelation: "kiosks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kiosk_tours_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
        ]
      }
      kiosks: {
        Row: {
          business_id: string | null
          can_create_bookings: boolean
          created_at: string
          id: string
          last_seen_at: string | null
          name: string
          pairing_code: string
          revoked_at: string | null
          simulated: boolean
          slug: string | null
          status: Database["public"]["Enums"]["kiosk_status"]
          stripe_account_id: string | null
          terminal_location_id: string | null
          updated_at: string
        }
        Insert: {
          business_id?: string | null
          can_create_bookings?: boolean
          created_at?: string
          id?: string
          last_seen_at?: string | null
          name: string
          pairing_code: string
          revoked_at?: string | null
          simulated?: boolean
          slug?: string | null
          status?: Database["public"]["Enums"]["kiosk_status"]
          stripe_account_id?: string | null
          terminal_location_id?: string | null
          updated_at?: string
        }
        Update: {
          business_id?: string | null
          can_create_bookings?: boolean
          created_at?: string
          id?: string
          last_seen_at?: string | null
          name?: string
          pairing_code?: string
          revoked_at?: string | null
          simulated?: boolean
          slug?: string | null
          status?: Database["public"]["Enums"]["kiosk_status"]
          stripe_account_id?: string | null
          terminal_location_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "kiosks_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      messaging_alerts: {
        Row: {
          created_at: string
          detail: Json | null
          id: string
          kind: string
          notified: boolean
          queued_remaining: number | null
          sent_last_hour: number | null
        }
        Insert: {
          created_at?: string
          detail?: Json | null
          id?: string
          kind?: string
          notified?: boolean
          queued_remaining?: number | null
          sent_last_hour?: number | null
        }
        Update: {
          created_at?: string
          detail?: Json | null
          id?: string
          kind?: string
          notified?: boolean
          queued_remaining?: number | null
          sent_last_hour?: number | null
        }
        Relationships: []
      }
      messaging_rules: {
        Row: {
          automation_id: string
          body: string | null
          business_tour_id: string | null
          channel: string
          created_at: string
          delay_minutes: number
          id: string
          is_active: boolean
          name: string
          only_first_contact: boolean
          trigger_event: string
          updated_at: string
          whatsapp_content_sid: string | null
          whatsapp_variables: Json | null
        }
        Insert: {
          automation_id?: string
          body?: string | null
          business_tour_id?: string | null
          channel: string
          created_at?: string
          delay_minutes?: number
          id?: string
          is_active?: boolean
          name: string
          only_first_contact?: boolean
          trigger_event?: string
          updated_at?: string
          whatsapp_content_sid?: string | null
          whatsapp_variables?: Json | null
        }
        Update: {
          automation_id?: string
          body?: string | null
          business_tour_id?: string | null
          channel?: string
          created_at?: string
          delay_minutes?: number
          id?: string
          is_active?: boolean
          name?: string
          only_first_contact?: boolean
          trigger_event?: string
          updated_at?: string
          whatsapp_content_sid?: string | null
          whatsapp_variables?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "messaging_rules_business_tour_id_fkey"
            columns: ["business_tour_id"]
            isOneToOne: false
            referencedRelation: "business_tours"
            referencedColumns: ["id"]
          },
        ]
      }
      messaging_settings: {
        Row: {
          alert_email: string | null
          alert_email_from: string
          alert_last_sent_at: string | null
          alert_phone: string | null
          automations_enabled: boolean
          booking_link_base: string
          id: boolean
          review_ask_delay_hours: number
          review_ask_lookback_hours: number
          review_automation_enabled: boolean
          review_reminder_hours: number
          sms_hourly_cap: number
          updated_at: string
        }
        Insert: {
          alert_email?: string | null
          alert_email_from?: string
          alert_last_sent_at?: string | null
          alert_phone?: string | null
          automations_enabled?: boolean
          booking_link_base?: string
          id?: boolean
          review_ask_delay_hours?: number
          review_ask_lookback_hours?: number
          review_automation_enabled?: boolean
          review_reminder_hours?: number
          sms_hourly_cap?: number
          updated_at?: string
        }
        Update: {
          alert_email?: string | null
          alert_email_from?: string
          alert_last_sent_at?: string | null
          alert_phone?: string | null
          automations_enabled?: boolean
          booking_link_base?: string
          id?: boolean
          review_ask_delay_hours?: number
          review_ask_lookback_hours?: number
          review_automation_enabled?: boolean
          review_reminder_hours?: number
          sms_hourly_cap?: number
          updated_at?: string
        }
        Relationships: []
      }
      reviews: {
        Row: {
          asked_at: string | null
          booking_id: string | null
          business_id: string
          cancel_reason: string | null
          cancelled_at: string | null
          comment: string | null
          created_at: string
          customer_id: string | null
          id: string
          link_clicked_at: string | null
          link_sent_at: string | null
          rating: number | null
          reask_sent_at: string | null
          responded_at: string | null
          source: string
          token: string
          updated_at: string
        }
        Insert: {
          asked_at?: string | null
          booking_id?: string | null
          business_id: string
          cancel_reason?: string | null
          cancelled_at?: string | null
          comment?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          link_clicked_at?: string | null
          link_sent_at?: string | null
          rating?: number | null
          reask_sent_at?: string | null
          responded_at?: string | null
          source?: string
          token?: string
          updated_at?: string
        }
        Update: {
          asked_at?: string | null
          booking_id?: string | null
          business_id?: string
          cancel_reason?: string | null
          cancelled_at?: string | null
          comment?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          link_clicked_at?: string | null
          link_sent_at?: string | null
          rating?: number | null
          reask_sent_at?: string | null
          responded_at?: string | null
          source?: string
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reviews_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_messages: {
        Row: {
          attempts: number
          body: string | null
          booking_id: string | null
          business_id: string | null
          channel: string
          created_at: string
          customer_id: string | null
          id: string
          last_error: string | null
          provider_sid: string | null
          rule_id: string | null
          send_at: string
          sent_at: string | null
          status: string
          tag: string | null
          to_phone: string
          updated_at: string
          whatsapp_content_sid: string | null
          whatsapp_variables: Json | null
        }
        Insert: {
          attempts?: number
          body?: string | null
          booking_id?: string | null
          business_id?: string | null
          channel: string
          created_at?: string
          customer_id?: string | null
          id?: string
          last_error?: string | null
          provider_sid?: string | null
          rule_id?: string | null
          send_at: string
          sent_at?: string | null
          status?: string
          tag?: string | null
          to_phone: string
          updated_at?: string
          whatsapp_content_sid?: string | null
          whatsapp_variables?: Json | null
        }
        Update: {
          attempts?: number
          body?: string | null
          booking_id?: string | null
          business_id?: string | null
          channel?: string
          created_at?: string
          customer_id?: string | null
          id?: string
          last_error?: string | null
          provider_sid?: string | null
          rule_id?: string | null
          send_at?: string
          sent_at?: string | null
          status?: string
          tag?: string | null
          to_phone?: string
          updated_at?: string
          whatsapp_content_sid?: string | null
          whatsapp_variables?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_messages_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "messaging_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_messages: {
        Row: {
          body: string
          booking_id: string | null
          business_id: string | null
          created_at: string
          customer_id: string | null
          direction: Database["public"]["Enums"]["sms_direction"]
          error: string | null
          from_phone: string
          id: string
          sent_by_staff_id: string | null
          status: string | null
          tag: string | null
          to_phone: string
          twilio_sid: string | null
        }
        Insert: {
          body: string
          booking_id?: string | null
          business_id?: string | null
          created_at?: string
          customer_id?: string | null
          direction: Database["public"]["Enums"]["sms_direction"]
          error?: string | null
          from_phone: string
          id?: string
          sent_by_staff_id?: string | null
          status?: string | null
          tag?: string | null
          to_phone: string
          twilio_sid?: string | null
        }
        Update: {
          body?: string
          booking_id?: string | null
          business_id?: string | null
          created_at?: string
          customer_id?: string | null
          direction?: Database["public"]["Enums"]["sms_direction"]
          error?: string | null
          from_phone?: string
          id?: string
          sent_by_staff_id?: string | null
          status?: string | null
          tag?: string | null
          to_phone?: string
          twilio_sid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_messages_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_messages_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_messages_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_messages_sent_by_staff_id_fkey"
            columns: ["sent_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_opt_outs: {
        Row: {
          created_at: string
          opted_out: boolean
          phone_number: string
          reason: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          opted_out?: boolean
          phone_number: string
          reason?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          opted_out?: boolean
          phone_number?: string
          reason?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      staff: {
        Row: {
          business_id: string | null
          can_check_in: boolean
          can_create_bookings: boolean
          can_delete_bookings: boolean
          can_edit_bookings: boolean
          created_at: string
          email: string
          full_name: string
          id: string
          is_active: boolean
          phone: string | null
          role: Database["public"]["Enums"]["staff_role"]
          updated_at: string
          user_id: string | null
        }
        Insert: {
          business_id?: string | null
          can_check_in?: boolean
          can_create_bookings?: boolean
          can_delete_bookings?: boolean
          can_edit_bookings?: boolean
          created_at?: string
          email: string
          full_name: string
          id?: string
          is_active?: boolean
          phone?: string | null
          role: Database["public"]["Enums"]["staff_role"]
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          business_id?: string | null
          can_check_in?: boolean
          can_create_bookings?: boolean
          can_delete_bookings?: boolean
          can_edit_bookings?: boolean
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          is_active?: boolean
          phone?: string | null
          role?: Database["public"]["Enums"]["staff_role"]
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_tours: {
        Row: {
          created_at: string
          staff_id: string
          tour_id: string
        }
        Insert: {
          created_at?: string
          staff_id: string
          tour_id: string
        }
        Update: {
          created_at?: string
          staff_id?: string
          tour_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_tours_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_tours_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_events: {
        Row: {
          account: string | null
          error: string | null
          id: string
          livemode: boolean | null
          payload: Json
          processed_at: string | null
          received_at: string
          type: string
        }
        Insert: {
          account?: string | null
          error?: string | null
          id: string
          livemode?: boolean | null
          payload: Json
          processed_at?: string | null
          received_at?: string
          type: string
        }
        Update: {
          account?: string | null
          error?: string | null
          id?: string
          livemode?: boolean | null
          payload?: Json
          processed_at?: string | null
          received_at?: string
          type?: string
        }
        Relationships: []
      }
      stripe_refunds: {
        Row: {
          amount: number
          booking_id: string | null
          business_id: string | null
          created_at: string
          created_by_staff_id: string | null
          currency: string
          id: string
          raw: Json | null
          reason: string | null
          status: string | null
          stripe_refund_id: string
          transaction_id: string | null
        }
        Insert: {
          amount?: number
          booking_id?: string | null
          business_id?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          currency?: string
          id?: string
          raw?: Json | null
          reason?: string | null
          status?: string | null
          stripe_refund_id: string
          transaction_id?: string | null
        }
        Update: {
          amount?: number
          booking_id?: string | null
          business_id?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          currency?: string
          id?: string
          raw?: Json | null
          reason?: string | null
          status?: string | null
          stripe_refund_id?: string
          transaction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stripe_refunds_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_refunds_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_refunds_created_by_staff_id_fkey"
            columns: ["created_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_refunds_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "stripe_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_transactions: {
        Row: {
          amount: number
          amount_refunded: number
          application_fee: number
          booking_id: string | null
          booking_ref: string | null
          business_id: string | null
          card_brand: string | null
          card_country: string | null
          card_last4: string | null
          charge_type: string | null
          connected_account_id: string | null
          created_at: string
          currency: string
          customer_email: string | null
          customer_name: string | null
          descriptor: string | null
          dispute_status: string | null
          id: string
          livemode: boolean | null
          net: number
          object_type: string | null
          on_behalf_of: string | null
          raw: Json
          receipt_url: string | null
          source: string | null
          status: string | null
          stripe_created: string | null
          stripe_fee: number
          stripe_id: string
          updated_at: string
        }
        Insert: {
          amount?: number
          amount_refunded?: number
          application_fee?: number
          booking_id?: string | null
          booking_ref?: string | null
          business_id?: string | null
          card_brand?: string | null
          card_country?: string | null
          card_last4?: string | null
          charge_type?: string | null
          connected_account_id?: string | null
          created_at?: string
          currency?: string
          customer_email?: string | null
          customer_name?: string | null
          descriptor?: string | null
          dispute_status?: string | null
          id?: string
          livemode?: boolean | null
          net?: number
          object_type?: string | null
          on_behalf_of?: string | null
          raw: Json
          receipt_url?: string | null
          source?: string | null
          status?: string | null
          stripe_created?: string | null
          stripe_fee?: number
          stripe_id: string
          updated_at?: string
        }
        Update: {
          amount?: number
          amount_refunded?: number
          application_fee?: number
          booking_id?: string | null
          booking_ref?: string | null
          business_id?: string | null
          card_brand?: string | null
          card_country?: string | null
          card_last4?: string | null
          charge_type?: string | null
          connected_account_id?: string | null
          created_at?: string
          currency?: string
          customer_email?: string | null
          customer_name?: string | null
          descriptor?: string | null
          dispute_status?: string | null
          id?: string
          livemode?: boolean | null
          net?: number
          object_type?: string | null
          on_behalf_of?: string | null
          raw?: Json
          receipt_url?: string | null
          source?: string | null
          status?: string | null
          stripe_created?: string | null
          stripe_fee?: number
          stripe_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_transactions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_transactions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      tour_name_aliases: {
        Row: {
          created_at: string
          id: string
          normalized_name: string
          raw_name: string | null
          source: string
          tour_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          normalized_name: string
          raw_name?: string | null
          source?: string
          tour_id: string
        }
        Update: {
          created_at?: string
          id?: string
          normalized_name?: string
          raw_name?: string | null
          source?: string
          tour_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tour_name_aliases_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
        ]
      }
      tour_pax_tiers: {
        Row: {
          business_tour_id: string
          created_at: string
          currency: string
          description: string | null
          id: string
          is_active: boolean
          label: string
          price_cents: number
          sort_order: number
          updated_at: string
        }
        Insert: {
          business_tour_id: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          label: string
          price_cents: number
          sort_order?: number
          updated_at?: string
        }
        Update: {
          business_tour_id?: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          label?: string
          price_cents?: number
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tour_pax_tiers_business_tour_id_fkey"
            columns: ["business_tour_id"]
            isOneToOne: false
            referencedRelation: "business_tours"
            referencedColumns: ["id"]
          },
        ]
      }
      tour_slot_closures: {
        Row: {
          closed_on: string
          created_at: string
          created_by: string | null
          id: string
          start_time: string
          tour_id: string
        }
        Insert: {
          closed_on: string
          created_at?: string
          created_by?: string | null
          id?: string
          start_time: string
          tour_id: string
        }
        Update: {
          closed_on?: string
          created_at?: string
          created_by?: string | null
          id?: string
          start_time?: string
          tour_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tour_slot_closures_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tour_slot_closures_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
        ]
      }
      tour_timeslots: {
        Row: {
          created_at: string
          duration_minutes: number
          id: string
          is_active: boolean
          sort_order: number
          start_time: string
          tour_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          duration_minutes: number
          id?: string
          is_active?: boolean
          sort_order?: number
          start_time: string
          tour_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          duration_minutes?: number
          id?: string
          is_active?: boolean
          sort_order?: number
          start_time?: string
          tour_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tour_timeslots_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
        ]
      }
      tours: {
        Row: {
          capacity: number
          color: string | null
          created_at: string
          id: string
          instructions: string | null
          is_active: boolean
          kind: string
          legacy_name_variations: string[]
          legacy_product_id: string | null
          meeting_point_address: string | null
          meeting_point_lat: number | null
          meeting_point_lng: number | null
          name: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          capacity: number
          color?: string | null
          created_at?: string
          id?: string
          instructions?: string | null
          is_active?: boolean
          kind: string
          legacy_name_variations?: string[]
          legacy_product_id?: string | null
          meeting_point_address?: string | null
          meeting_point_lat?: number | null
          meeting_point_lng?: number | null
          name: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          capacity?: number
          color?: string | null
          created_at?: string
          id?: string
          instructions?: string | null
          is_active?: boolean
          kind?: string
          legacy_name_variations?: string[]
          legacy_product_id?: string | null
          meeting_point_address?: string | null
          meeting_point_lat?: number | null
          meeting_point_lng?: number | null
          name?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      whatsapp_messages: {
        Row: {
          body: string
          booking_id: string | null
          business_id: string
          created_at: string
          customer_id: string | null
          error: string | null
          from_phone: string
          id: string
          sent_by_staff_id: string | null
          status: string
          to_phone: string
          twilio_sid: string | null
        }
        Insert: {
          body: string
          booking_id?: string | null
          business_id: string
          created_at?: string
          customer_id?: string | null
          error?: string | null
          from_phone: string
          id?: string
          sent_by_staff_id?: string | null
          status: string
          to_phone: string
          twilio_sid?: string | null
        }
        Update: {
          body?: string
          booking_id?: string | null
          business_id?: string
          created_at?: string
          customer_id?: string | null
          error?: string | null
          from_phone?: string
          id?: string
          sent_by_staff_id?: string | null
          status?: string
          to_phone?: string
          twilio_sid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_sent_by_staff_id_fkey"
            columns: ["sent_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      analytics_daily_by_tour: {
        Args: { p_end: string; p_start: string; p_tz: string }
        Returns: {
          bookings: number
          business_tour_id: string
          color: string
          day: number
          pax: number
          tour: string
        }[]
      }
      analytics_source_tour: {
        Args: { p_end: string; p_start: string }
        Returns: {
          bookings: number
          business: string
          business_id: string
          color: string
          pax: number
          source: string
          tour: string
        }[]
      }
      app_norm: { Args: { s: string }; Returns: string }
      bookings_checkin_manifest: {
        Args: { p_end: string; p_start: string }
        Returns: {
          remaining_pax: number
          slot_start: string
          total_pax: number
        }[]
      }
      claim_due_scheduled_messages: {
        Args: { batch?: number }
        Returns: {
          attempts: number
          body: string | null
          booking_id: string | null
          business_id: string | null
          channel: string
          created_at: string
          customer_id: string | null
          id: string
          last_error: string | null
          provider_sid: string | null
          rule_id: string | null
          send_at: string
          sent_at: string | null
          status: string
          tag: string | null
          to_phone: string
          updated_at: string
          whatsapp_content_sid: string | null
          whatsapp_variables: Json | null
        }[]
        SetofOptions: {
          from: "*"
          to: "scheduled_messages"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      current_staff: {
        Args: never
        Returns: {
          business_id: string
          role: Database["public"]["Enums"]["staff_role"]
          staff_id: string
        }[]
      }
      dashboard_monthly_guests: {
        Args: { p_end: string; p_start: string; p_tz?: string }
        Returns: {
          checked_guests: number
          day: number
          guests: number
        }[]
      }
      generate_booking_token: { Args: never; Returns: string }
      groupon_candidates: {
        Args: never
        Returns: {
          aliases: string[]
          business_id: string
          business_name: string
          business_tour_id: string
          groupon_fee_cents: number
          product_name: string
          tour_id: string
          tour_name: string
        }[]
      }
      ignore_email_match: {
        Args: { p_queue_id: string }
        Returns: {
          ai_confidence: string | null
          booking_channel: string | null
          business_id: string | null
          created_at: string
          id: string
          legacy_company_id: string | null
          original_product_name: string | null
          parsed: Json | null
          reason: string
          resolved_at: string | null
          resolved_by_staff_id: string | null
          resolved_tour_id: string | null
          status: string
          suggested_tour_id: string | null
          supplier: string | null
        }
        SetofOptions: {
          from: "*"
          to: "email_match_queue"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      match_ota_tour: {
        Args: {
          p_channel: string
          p_company: string
          p_product: string
          p_supplier: string
        }
        Returns: {
          business_id: string
          business_tour_id: string
          method: string
          tour_id: string
          tour_name: string
        }[]
      }
      resolve_email_match: {
        Args: { p_queue_id: string; p_tour_id: string }
        Returns: {
          ai_confidence: string | null
          booking_channel: string | null
          business_id: string | null
          created_at: string
          id: string
          legacy_company_id: string | null
          original_product_name: string | null
          parsed: Json | null
          reason: string
          resolved_at: string | null
          resolved_by_staff_id: string | null
          resolved_tour_id: string | null
          status: string
          suggested_tour_id: string | null
          supplier: string | null
        }
        SetofOptions: {
          from: "*"
          to: "email_match_queue"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      sms_conversations: {
        Args: never
        Returns: {
          counterpart: string
          last_at: string
          last_body: string
          last_direction: Database["public"]["Enums"]["sms_direction"]
          message_count: number
        }[]
      }
      payments_summary: {
        Args: {
          p_business?: string
          p_end: string
          p_source?: string
          p_start: string
        }
        Returns: {
          card_count: number
          card_gross: number
          cash_count: number
          cash_total: number
          refunded: number
        }[]
      }
      stripe_payments_summary: {
        Args: { p_end: string; p_start: string }
        Returns: {
          application_fees: number
          gross: number
          net: number
          refunded: number
          stripe_fees: number
          txn_count: number
        }[]
      }
    }
    Enums: {
      booking_status:
        | "pending"
        | "confirmed"
        | "checked_in"
        | "completed"
        | "cancelled"
      kiosk_status: "active" | "revoked"
      sms_direction: "inbound" | "outbound"
      staff_role: "owner" | "business_manager" | "check_in"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      booking_status: [
        "pending",
        "confirmed",
        "checked_in",
        "completed",
        "cancelled",
      ],
      kiosk_status: ["active", "revoked"],
      sms_direction: ["inbound", "outbound"],
      staff_role: ["owner", "business_manager", "check_in"],
    },
  },
} as const
