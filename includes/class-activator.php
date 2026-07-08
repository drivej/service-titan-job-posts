<?php
/**
 * Registers the plugin content model and activation behavior.
 */

if (! defined('ABSPATH')) {
    exit;
}

class ST_Sync_Activator
{
    public static function activate(): void
    {
        self::register_content_model();
        self::grant_reviewer_capabilities();
        flush_rewrite_rules();
        update_option('st_sync_version', ST_SYNC_VERSION);
    }

    public static function maybe_upgrade(): void
    {
        if (ST_SYNC_VERSION === get_option('st_sync_version')) {
            return;
        }

        self::grant_reviewer_capabilities();
        flush_rewrite_rules();
        update_option('st_sync_version', ST_SYNC_VERSION);
    }

    public static function register_content_model(): void
    {
        self::register_taxonomies();
        self::register_job_post_type();
        self::register_job_meta();
    }

    /**
     * Backward-compatible alias used by early plugin versions.
     */
    public static function register_st_jobs(): void
    {
        self::register_content_model();
    }

    private static function register_taxonomies(): void
    {
        register_taxonomy('st_service', ['st_job'], [
            'labels' => [
                'name'          => __('Services', 'service-titan-job-post'),
                'singular_name' => __('Service', 'service-titan-job-post'),
            ],
            'public'            => false,
            'show_ui'           => true,
            'show_admin_column' => true,
            'show_in_rest'      => true,
            'hierarchical'      => false,
            'rewrite'           => false,
        ]);

        register_taxonomy('st_location', ['st_job'], [
            'labels' => [
                'name'          => __('Locations', 'service-titan-job-post'),
                'singular_name' => __('Location', 'service-titan-job-post'),
            ],
            'public'            => false,
            'show_ui'           => true,
            'show_admin_column' => true,
            'show_in_rest'      => true,
            'hierarchical'      => false,
            'rewrite'           => false,
        ]);
    }

    private static function register_job_post_type(): void
    {
        add_rewrite_tag('%st_service%', '([^/]+)', 'st_service=');
        add_rewrite_tag('%st_location%', '([^/]+)', 'st_location=');

        register_post_type('st_job', [
            'labels' => [
                'name'               => __('Local Jobs', 'service-titan-job-post'),
                'singular_name'      => __('Local Job', 'service-titan-job-post'),
                'add_new_item'       => __('Add Local Job', 'service-titan-job-post'),
                'edit_item'          => __('Review Local Job', 'service-titan-job-post'),
                'not_found'          => __('No local jobs found.', 'service-titan-job-post'),
                'pending_items'      => __('Pending Local Jobs', 'service-titan-job-post'),
            ],
            'public'              => true,
            'show_in_rest'        => true,
            'rest_base'           => 'st-jobs',
            'supports'            => ['title', 'editor', 'excerpt', 'revisions'],
            'has_archive'         => false,
            'exclude_from_search' => false,
            'rewrite'             => [
                'slug'       => '%st_service%/%st_location%/job',
                'with_front' => false,
            ],
            'capability_type'     => ['st_job', 'st_jobs'],
            'map_meta_cap'        => true,
            'capabilities'        => [
                'create_posts' => 'do_not_allow',
            ],
            'menu_icon'           => 'dashicons-location-alt',
        ]);
    }

    private static function register_job_meta(): void
    {
        $string_fields = [
            'st_job_id',
            'st_job_tenant_id',
            'st_job_number',
            'st_job_date',
            'st_job_city',
            'st_job_state',
            'st_job_service',
            'st_job_summary',
            'st_job_location_id',
            'st_job_type_id',
            'st_job_type_name',
            'st_job_sync_hash',
            'st_job_update_available',
            'st_job_pending_summary',
            'st_job_pending_completed_on',
            'st_job_pending_city',
            'st_job_pending_state',
            'st_job_pending_service_slug',
            'st_job_pending_service_name',
            'st_job_pending_location_slug',
            'st_job_pending_location_id',
            'st_job_pending_job_type_id',
            'st_job_pending_job_type_name',
            'st_job_pending_total',
        ];

        foreach ($string_fields as $field) {
            register_post_meta('st_job', $field, [
                'type'              => 'string',
                'single'            => true,
                'show_in_rest'      => false,
                'sanitize_callback' => 'sanitize_text_field',
                'auth_callback'     => static function (): bool {
                    return current_user_can('edit_posts');
                },
            ]);
        }

        register_post_meta('st_job', 'st_job_price', [
            'type'              => 'number',
            'single'            => true,
            'show_in_rest'      => false,
            'sanitize_callback' => static function ($value): float {
                return (float) $value;
            },
            'auth_callback'     => static function (): bool {
                return current_user_can('edit_posts');
            },
        ]);
    }

    private static function grant_reviewer_capabilities(): void
    {
        $capabilities = [
            'edit_st_job',
            'read_st_job',
            'delete_st_job',
            'edit_st_jobs',
            'edit_others_st_jobs',
            'edit_private_st_jobs',
            'edit_published_st_jobs',
            'publish_st_jobs',
            'read_private_st_jobs',
            'delete_st_jobs',
            'delete_private_st_jobs',
            'delete_published_st_jobs',
            'delete_others_st_jobs',
        ];

        foreach (['administrator', 'editor'] as $role_name) {
            $role = get_role($role_name);
            if (! $role) {
                continue;
            }

            foreach ($capabilities as $capability) {
                $role->add_cap($capability);
            }
        }
    }
}
