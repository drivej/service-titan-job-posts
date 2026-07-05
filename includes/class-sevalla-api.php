<?php
/**
 * Registers REST API endpoints for the Sevalla Node.js worker.
 */

if (! defined('ABSPATH')) {
    exit;
}

class ST_Sync_Sevalla_API
{

    public function __construct()
    {
        // Hook into the REST API initialization
        add_action('rest_api_init', [$this, 'register_settings_endpoint']);
    }

    /**
     * Register the /wp-json/st-sync/v1/settings route.
     */
    public function register_settings_endpoint(): void
    {
        register_rest_route('st-sync/v1', '/settings', [
            'methods'             => 'GET',
            'callback'            => [$this, 'get_sync_settings'],
            'permission_callback' => '__return_true',
            // 'permission_callback' => [$this, 'check_sync_permissions'],
        ]);
    }

    /**
     * Callback to return plugin settings to Sevalla.
     *
     * @param WP_REST_Request $request Full details about the request.
     * @return WP_REST_Response
     */
    public function get_sync_settings(WP_REST_Request $request): WP_REST_Response
    {
        $options = get_option('st_sync_options', []);
        return new WP_REST_Response($options, 200);
    }

    /**
     * Permission check: Ensure requester has 'manage_options' capability.
     * (WordPress Application Passwords fulfill this).
     *
     * @return bool
     */
    public function check_sync_permissions(): bool
    {
        return current_user_can('manage_options');
    }
}

// Initialize the class
new ST_Sync_Sevalla_API();
