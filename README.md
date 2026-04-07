# Vine Explorer Scrape and Share

## Disclaimer
This extension is in no way intended to circumvent any Amazon policies or to gain an unfair advantage in ordering from Amazon Vine. This extension is in no way official and may not comply with the guidelines. So please never contact Amazon or sellers with questions or problems with this extension. Use at your own risk and if you lose your Vine status as a result, you are solely responsible.

## Description
This is intended operate on the https://www.amazon.com/vine/vine-items?queue=potluck site to give Vine participants more information on the products, different ways of viewing the products, and better search capability since the search on Vine is not as fuzzy or comprehensive as a Google search or even a regular Amazon product search.

A normal user would page through the items looking for items of interest. They would click on the details buttons to see what the ETV (Estimated Taxable Value) is as some people try to limit their taxable impact of the Vine program.

Searching should look in both the title as well as the full description of the items. Since Vine search does not accomplish that, we will pull that data into a local database and then do our searches from that location.

Products come and go frequently, so we will need to periodically go through the database and see if the products are still avaialble. A product that is no longer available should be tagged as removed in the database. An optional purge should be offered so that the DB size can be reduced as time goes on. Keeping the removed products in the DB for a while allows for more reporting functions and historical searches.

The user can create a list of keywords that they are looking for. This list of keywords will be used to provide toast notifications for products matching any of the keywords.

## Requirements
In order to prevent being banned by Amazon, the system should be very aware of making the timing of actions correspond as close as possible to a standard users interactions. 

## Reporting capability

## GUI Options
Several GUI Options should be available.
### Option 1 - Overlay for existing Site
One option would be an overlay for the existing site. Similar functions to https://github.com/deburau/AmazonVineExplorer should be included here.

### Option 2 - Compact view
This option would be a separate page that would only have the items and information that has been pulled into the Database so far. This may not represent all of the items and it may not have the newest items that have been posted on the site.

This option should have a table view where it shows the image in a small size with rollovr to zoom in, title, description with a small portion of the description showing and a rollover that will display the full description, an icon that shows if there are options available for the item, the ETV if it has been found yet, 

|Image|Title|Vendor|Description|Options|ETV|
|--------------------------|------------|------------|------------|------------|------------|
|![alt text](README-images/image.png)|TimeRalo Fingerprint Time Clock for Small Businesses - App-Based Attendance System with Smart Scheduling, Overtime & Lunch Rules, 2.4GHz WiFi, Auto Reports, No Monthly Fees (with 10 ID Cards)|TimeRalo|Fast & Accurate Recognition: Our high-precision fingerprint time clock has been tested for 1,000,000+ touches, with FAR <0.001% and FRR <1%, ensuring reliable, fast, and secure access every time. It effectively prevents buddy punching, ensures accurate attendance tracking.<br>Easy Setup & App Remote Control: Simple 3-step setup with no technical expertise required. Manage shifts, view real-time records, and edit data anytime via the mobile app. Flexible scheduling supports fixed shifts, rotating shifts, night shifts and cross-day attendance, adapting to diverse business operation needs.<br>Smart Rules & Automatic Reports: Built-in overtime calculation, break rules and multiple pay period settings. The system automatically generates visual attendance reports and sends them via email, greatly reducing manual paperwork and payroll errors, saving hours of administrative work each month.<br>WiFi & Offline Recording, No Monthly Fees: Supports 2.4GHz WiFi sync and reliable offline punching. Data will automatically upload once reconnected. One-time purchase with zero recurring fees, no subscriptions or hidden costs, making it a cost-effective choice for small businesses.<br>Wide Application: Ideal for restaurants, retail stores, factories, offices, and 24-hour teams, supporting up to 500 employees. It handles cross-day night shifts, early handovers, and custom rules for each department/employee. Backed by U.S.-based customer support and a 1-year warranty, it’s the simple, modern replacement for outdated paper-based attendance systems.|$109.99|


## Stretch Goals
A publically available storage location should be available that multiple users can submit database updates to. Updates would be pushed automatically and the public storage be polled frequntly for new products. The intent is to prevent checking products that have already been checked especially for the ETV which is the most transactionally heavy part that would cause Amazon to identify bad behavior.

