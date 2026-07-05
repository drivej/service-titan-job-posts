<?php
if ( ! defined('ABSPATH' ) ) exit;
/**
 * Add the top-level menu for our plugin
 */
function st_sync_add_admin_menu() {
    add_menu_page(
        'ST Sync Settings',       // Page Title
        'ST Sync',                // Menu Title
        'manage_options',         // Capability required
        'st_sync_settings',       // Menu slug
        'st_sync_settings_page',  // Function to render HTML
        'dashicons-cloud',        // Icon
        100                       // Position
    );
}
add_action('admin_menu', 'st_sync_add_admin_menu');
