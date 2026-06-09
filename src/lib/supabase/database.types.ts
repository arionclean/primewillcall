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
          id: string
          notes: string | null
          pax_adult: number
          pax_child: number
          pax_infant: number
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
          id?: string
          notes?: string | null
          pax_adult?: number
          pax_child?: number
          pax_infant?: number
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
          id?: string
          notes?: string | null
          pax_adult?: number
          pax_child?: number
          pax_infant?: number
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
      business_tours: {
        Row: {
          business_id: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          tour_id: string
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          tour_id: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
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
          created_at: string
          id: string
          logo_url: string | null
          name: string
          phone: string | null
          slug: string
          timezone: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          id?: string
          logo_url?: string | null
          name: string
          phone?: string | null
          slug: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          id?: string
          logo_url?: string | null
          name?: string
          phone?: string | null
          slug?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      customers: {
        Row: {
          business_id: string
          created_at: string
          email: string | null
          full_name: string
          id: string
          notes: string | null
          phone: string | null
          stripe_customer_id: string | null
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          email?: string | null
          full_name: string
          id?: string
          notes?: string | null
          phone?: string | null
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
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
          created_at: string
          id: string
          last_seen_at: string | null
          name: string
          pairing_code: string
          revoked_at: string | null
          status: Database["public"]["Enums"]["kiosk_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_seen_at?: string | null
          name: string
          pairing_code: string
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["kiosk_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          last_seen_at?: string | null
          name?: string
          pairing_code?: string
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["kiosk_status"]
          updated_at?: string
        }
        Relationships: []
      }
      staff: {
        Row: {
          business_id: string | null
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
          meeting_point_address?: string | null
          meeting_point_lat?: number | null
          meeting_point_lng?: number | null
          name?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_staff: {
        Args: never
        Returns: {
          business_id: string
          role: Database["public"]["Enums"]["staff_role"]
          staff_id: string
        }[]
      }
      dashboard_monthly_guests: {
        Args: { p_start: string; p_end: string; p_tz?: string }
        Returns: {
          day: number
          guests: number
          checked_guests: number
        }[]
      }
      analytics_source_tour: {
        Args: { p_start: string; p_end: string }
        Returns: {
          source: string
          tour: string
          color: string | null
          business_id: string
          business: string
          pax: number
          bookings: number
        }[]
      }
      analytics_daily_by_tour: {
        Args: { p_start: string; p_end: string; p_tz: string }
        Returns: {
          day: number
          business_tour_id: string
          tour: string
          color: string | null
          pax: number
          bookings: number
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
      staff_role: ["owner", "business_manager", "check_in"],
    },
  },
} as const
