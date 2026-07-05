<?php
/**
 * Plugin Name:       Service Titan Job Post
 * Plugin URI:        https://example.com/service-titan-job-post
 * Description:       A brief description of what this amazing plugin does.
 * Version:           1.0.0
 * Author:            Your Name
 * Author URI:        https://example.com
 * License:           GPLv2 or later
 * Text Domain:       service-titan-job-post
 */

// Exit if accessed directly to protect against malicious execution
if (! defined('ABSPATH')) {
    exit;
}

require_once plugin_dir_path(__FILE__) . 'includes/class-activator.php';

// Custom post types must be registered on every request so their REST routes exist.
add_action('init', ['ST_Sync_Activator', 'register_st_jobs']);

/**
 * The code that runs during plugin activation.
 * This action is documented in includes/class-activator.php
 */
function activate_st_sync()
{
    ST_Sync_Activator::activate();
}
/**
 * The code that runs during plugin deactivation.
 */
function deactivate_st_sync()
{
    require_once plugin_dir_path(__FILE__) . 'includes/class-deactivator.php';
    ST_Sync_Deactivator::deactivate();
}
register_activation_hook(__FILE__, 'activate_st_sync');
register_deactivation_hook(__FILE__, 'deactivate_st_sync');

/**
 * Load and Initialize the Admin Settings Page
 */
$st_admin_path = plugin_dir_path( __FILE__ ) . 'admin/class-st-sync-admin.php';

if ( file_exists( $st_admin_path ) ) {
    require_once $st_admin_path;
    
    // Ensure the class name matches what you wrote in the admin file
    if ( class_exists( 'ST_Sync_Admin' ) ) {
        new ST_Sync_Admin();
    }
}
/**
 * Load and Initialize the Gutenberg Blocks
 */
require_once plugin_dir_path( __FILE__ ) . 'includes/class-sync-blocks.php';

require_once plugin_dir_path( __FILE__ ) . 'includes/class-sevalla-api.php';
