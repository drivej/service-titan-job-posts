<?php
/**
 * Fired during plugin activation.
 */
class ST_Sync_Activator
{

    public static function activate()
    {
        // 1. Manually trigger the CPT registration
        // (This ensures WP knows about the post type before we flush rules)
        self::register_st_jobs();

        // 2. Clear permalinks
        flush_rewrite_rules();
    }

    /**
     * Register the ServiceTitan job post type and its REST-enabled metadata.
     *
     * This must run on every WordPress request, not only during activation.
     */
    public static function register_st_jobs(): void
    {
        $args = [
            'label'        => 'ServiceTitan Jobs',
            'public'       => true,
            'show_in_rest' => true, // Essential for Sevalla Node.js to push data
            'rest_base'    => 'st-jobs',
            'supports'     => ['title', 'editor', 'custom-fields'],
            'has_archive'  => true,
        ];

        register_post_type('st_job', $args);

        register_post_meta('st_job', 'st_job_id', [
            'type'              => 'string',
            'single'            => true,
            'show_in_rest'      => true,
            'sanitize_callback' => static function ($value): string {
                return sanitize_text_field((string) $value);
            },
            'auth_callback'     => static function (): bool {
                return current_user_can('edit_posts');
            },
        ]);

        register_post_meta('st_job', 'st_job_number', [
            'type'              => 'string',
            'single'            => true,
            'show_in_rest'      => true,
            'sanitize_callback' => static function ($value): string {
                return sanitize_text_field((string) $value);
            },
            'auth_callback'     => static function (): bool {
                return current_user_can('edit_posts');
            },
        ]);

        register_post_meta('st_job', 'st_job_price', [
            'type'              => 'number',
            'single'            => true,
            'show_in_rest'      => true,
            'sanitize_callback' => static function ($value): float {
                return (float) $value;
            },
            'auth_callback'     => static function (): bool {
                return current_user_can('edit_posts');
            },
        ]);

        register_post_meta('st_job', 'st_job_date', [
            'type'              => 'string',
            'single'            => true,
            'show_in_rest'      => true,
            'sanitize_callback' => static function ($value): string {
                return sanitize_text_field((string) $value);
            },
            'auth_callback'     => static function (): bool {
                return current_user_can('edit_posts');
            },
        ]);
    }
}
